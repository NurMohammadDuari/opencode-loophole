/**
 * Zen Bridge — REAL OpenAI-compat front door on :1343
 *
 * Pure zen path — no g4f fallback.
 *
 * Flow: opencode client → bridge:1343 → opencode serve:18765 → rotator:1341 → opencode.ai/zen/v1
 *
 * When zen returns empty text (idle-before-delta race) or times out, the request
 * fails with a proper error response instead of silently sending blank output.
 *
 * FIXES:
 *  - /v1/responses route (OpenAI Responses API → full SSE event sequence)
 *  - SSE "failed after headers sent" race: finish(err) resolves instead of rejects
 *  - idle-before-delta blank output fix: flushAndFinish() + isIdle handler check
 *    fullText==="" and close the stream with an error instead of blank content
 *  - Non-live models use ZEN_REMAP_TIMEOUT_MS (30s) for faster failure
 *  - models-catalog remap: non-working zen models route to a confirmed live model
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SERVE_HOST = "127.0.0.1";
const SERVE_PORT = Number(process.env.SERVE_PORT || 18765);
const SERVE_USER = process.env.SERVE_USER || "opencode";
const SERVE_PASS = process.env.SERVE_PASS || "opencodepass";
const PORT = process.env.BRIDGE_PORT ? Number(process.env.BRIDGE_PORT) : 1343;
const FAST_RACE = process.env.FAST_RACE === "1";
const ZEN_TIMEOUT_MS = Number(process.env.ZEN_TIMEOUT_MS || 90000);
// Shorter timeout for remapped (non-zen-live) models
const ZEN_REMAP_TIMEOUT_MS = Number(process.env.ZEN_REMAP_TIMEOUT_MS || 30000);

const SHARE = path.join(os.homedir(), ".local", "share", "opencode");
const ACTIVITY_LOG = process.env.BRIDGE_ACTIVITY_LOG || path.join(SHARE, "bridge-activity.jsonl");
const PROOF_FILE = process.env.BRIDGE_PROOF_FILE || path.join(SHARE, "loophole-proof.json");
const ROTATOR_PROOF = process.env.ROTATOR_PROOF_FILE || path.join(SHARE, "rotator-proof.jsonl");

const AUTH = "Basic " + Buffer.from(`${SERVE_USER}:${SERVE_PASS}`).toString("base64");
const serveAgent = new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000 });

const CATALOG_CANDIDATES = process.env.MODELS_CATALOG
  ? [process.env.MODELS_CATALOG]
  : [
      path.join(SHARE, "models-catalog.json"),
      path.join(os.homedir(), ".local", "share", "opencode", "models-catalog.json"),
      path.join(__dirname, "models-catalog.json"),
      path.join(__dirname, "..", "models-catalog.json"),
      path.join(__dirname, "..", "config", "models-catalog.json"),
    ];
let CATALOG = { zen_live_free: ["big-pickle"], whitelist_31: ["big-pickle"], remap_to_zen_live: {} };
let catalogLoaded = false;
for (const cp of CATALOG_CANDIDATES) {
  try {
    CATALOG = JSON.parse(fs.readFileSync(cp, "utf8"));
    console.log("catalog loaded from", cp, "—", (CATALOG.whitelist_31 || []).length, "models");
    catalogLoaded = true;
    break;
  } catch {}
}
if (!catalogLoaded) console.error("catalog load failed — using big-pickle fallback");

const FAST_ZEN = new Set(CATALOG.zen_live_free || ["big-pickle"]);
const MODEL_REMAP = CATALOG.remap_to_zen_live || {};
const WHITELIST = CATALOG.whitelist_31 || ["big-pickle"];

let lastProof = {
  ts: 0, real: true,
  chain: ["opencode-client", "bridge:1343", "serve:18765", "rotator:1341", "opencode.ai/zen/v1"],
  note: "waiting for first request",
};

function logActivity(entry) {
  try { fs.appendFileSync(ACTIVITY_LOG, JSON.stringify({ ts: Date.now(), ...entry }) + "\n"); } catch {}
}

function writeProof(p) {
  lastProof = { ts: Date.now(), real: true, ...p };
  try { fs.writeFileSync(PROOF_FILE, JSON.stringify(lastProof, null, 2)); } catch {}
}

function readRotatorTail(n = 5) {
  try {
    if (!fs.existsSync(ROTATOR_PROOF)) return [];
    const lines = fs.readFileSync(ROTATOR_PROOF, "utf8").split(/\r?\n/).filter(Boolean).slice(-n);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function modelName(m) {
  if (typeof m !== "string") return "big-pickle";
  return m.split("/").pop().replace(/^opencode:/, "");
}

function resolveZenModel(m) {
  const raw = modelName(m);
  if (FAST_ZEN.has(raw) || WHITELIST.includes(raw) || raw === "big-pickle")
    return { requested: raw, zenModel: raw, remapped: false };
  if (MODEL_REMAP[raw]) return { requested: raw, zenModel: MODEL_REMAP[raw], remapped: true };
  return { requested: raw, zenModel: "big-pickle", remapped: true };
}

function messageText(m) {
  if (m == null) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content))
    return m.content.map((p) => (typeof p === "string" ? p : (p && (p.text || p.content)) || "")).join("");
  return String(m.content || "");
}

function httpJson(agent, hostname, port, method, reqPath, body, timeoutMs, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = http.request({
      agent, hostname, port, path: reqPath, method,
      headers: {
        "content-type": "application/json",
        ...(data ? { "content-length": Buffer.byteLength(data) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      let out = "";
      res.on("data", (c) => { out += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: out ? JSON.parse(out) : null, raw: out }); }
        catch { resolve({ status: res.statusCode, json: { raw: out }, raw: out }); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout " + timeoutMs + "ms")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function callServe(method, reqPath, body, timeoutMs = ZEN_TIMEOUT_MS) {
  return httpJson(serveAgent, SERVE_HOST, SERVE_PORT, method, reqPath, body, timeoutMs, {
    authorization: AUTH,
  });
}

function proofHeaders(extra = {}) {
  return {
    "x-loophole-real": "1",
    "x-loophole-chain": "bridge->serve->rotator->opencode.ai/zen/v1",
    "x-loophole-simulation": "0",
    ...extra,
  };
}

function responsesBodyToChatBody(body) {
  const input = body.input;
  let messages = [];
  if (typeof input === "string") {
    messages = [{ role: "user", content: input }];
  } else if (Array.isArray(input)) {
    messages = input.map((item) => {
      if (item && item.type === "message") {
        const role = item.role || "user";
        let content = "";
        if (typeof item.content === "string") content = item.content;
        else if (Array.isArray(item.content))
          content = item.content.map((c) => (typeof c === "string" ? c : c.text || c.content || "")).join("");
        return { role, content };
      }
      return { role: "user", content: typeof item === "string" ? item : JSON.stringify(item) };
    });
  } else {
    messages = [{ role: "user", content: "" }];
  }
  if (body.instructions && typeof body.instructions === "string")
    messages = [{ role: "system", content: body.instructions }, ...messages];
  return {
    model: body.model || "big-pickle",
    messages,
    stream: !!body.stream,
    temperature: body.temperature,
    max_tokens: body.max_output_tokens || body.max_tokens,
  };
}

// ── Responses API SSE streaming ──────────────────────────────────────────────
function zenStreamResponsesToClient(res, model, chatBody, timeoutMs) {
  timeoutMs = timeoutMs || ZEN_TIMEOUT_MS;
  return new Promise(async (resolve, reject) => {
    const t0 = Date.now();
    let sessionID = null;
    let assistantMsgId = null;
    let fullText = "";
    let tokens = null;
    let settled = false;
    let sub = null;
    const respId = "resp_" + crypto.randomBytes(12).toString("hex");
    const itemId = "item_" + crypto.randomBytes(8).toString("hex");
    const created = Math.floor(Date.now() / 1000);

    const safeWrite = (obj) => {
      try { res.write("event: " + obj.type + "\ndata: " + JSON.stringify({ sequence_number: seq(), ...obj }) + "\n\n"); } catch {}
    };

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (sub) sub.close();
      setTimeout(() => {
        if (sessionID) callServe("DELETE", `/session/${sessionID}`, null, 5000).catch(() => {});
      }, 2000);
      if (err) {
        if (res.headersSent) {
          if (fullText === "") {
            // Blank output: close stream with error event instead of empty text
            try {
              safeWrite({ type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: "[zen: no response — model may be unavailable, try big-pickle or muse-spark-1.3-contributor-free]" });
              safeWrite({ type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text: "[zen: no response]" });
              safeWrite({ type: "response.content_part.done", item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "[zen: no response]", annotations: [] } });
              safeWrite({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: itemId, role: "assistant", content: [{ type: "output_text", text: "[zen: no response]", annotations: [] }], status: "completed" } });
              safeWrite({ type: "response.completed", response: buildResponseObj(respId, model, created, "[zen: no response]", tokens, "completed") });
              res.write("data: [DONE]\n\n");
              res.end();
            } catch {}
            resolve({ sessionID, text: "", tokens, ms: Date.now() - t0, path: "zen-responses-notext", streamErr: err.message });
            return;
          }
          try {
            safeWrite({ type: "response.completed", response: buildResponseObj(respId, model, created, fullText, tokens, "incomplete") });
            res.write("data: [DONE]\n\n");
            res.end();
          } catch {}
          resolve({ sessionID, text: fullText, tokens, ms: Date.now() - t0, path: "zen-responses-partial", streamErr: err.message });
        } else {
          reject(err);
        }
      } else {
        resolve({ sessionID, text: fullText, tokens, ms: Date.now() - t0, path: "zen-responses" });
      }
    };

    let seqNum = 0;
    const seq = () => ++seqNum;

    function buildResponseObj(id, mdl, ts, text, tok, status) {
      const isInProgress = status === "in_progress";
      return {
        id, object: "response", created_at: ts, model: mdl, status: status || "completed",
        output: isInProgress ? [] : [{
          type: "message", id: itemId, role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }], status: "completed",
        }],
        usage: tok
          ? { input_tokens: tok.input || tok.prompt || 0, output_tokens: tok.output || tok.completion || 0, total_tokens: tok.total || 0 }
          : { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      };
    }

    try {
      const session = await callServe("POST", "/session", { directory: null }, 15000);
      if (session.status !== 200 || !session.json || !session.json.id)
        throw new Error("serve session failed: " + session.status);
      sessionID = session.json.id;

      res.writeHead(200, {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive",
        ...proofHeaders({ "x-loophole-path": "zen-responses", "x-loophole-session": sessionID, "x-loophole-model": model }),
      });

      safeWrite({ type: "response.created", response: buildResponseObj(respId, model, created, "", null, "in_progress") });
      safeWrite({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: itemId, role: "assistant", content: [], status: "in_progress" } });
      safeWrite({ type: "response.content_part.added", item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });

      const timer = setTimeout(() => finish(new Error("zen responses stream timeout")), timeoutMs);

      let lastDeltaAt = Date.now();
      const stallCheck = setInterval(() => {
        if (settled) { clearInterval(stallCheck); return; }
        if (fullText.length > 0 && Date.now() - lastDeltaAt > 15000) {
          clearInterval(stallCheck); clearTimeout(timer); flushAndFinish();
        }
      }, 2000);

      function flushAndFinish() {
        if (settled) return;
        // If idle fired but no text yet, wait up to 2s for late-arriving deltas
        // (SSE race: session.idle can arrive before message.part.delta over the stream)
        if (fullText === "") {
          setTimeout(() => {
            if (settled) return;
            if (fullText === "") {
              console.error("Zen Bridge: idle-before-delta for", model, "— no text after 2s wait, closing with error");
              finish(new Error("idle-with-no-text"));
            } else {
              flushAndFinish(); // text arrived during the wait — flush normally
            }
          }, 2000);
          return;
        }
        try {
          safeWrite({ type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text: fullText });
          safeWrite({ type: "response.content_part.done", item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: fullText, annotations: [] } });
          safeWrite({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: itemId, role: "assistant", content: [{ type: "output_text", text: fullText, annotations: [] }], status: "completed" } });
          safeWrite({ type: "response.completed", response: buildResponseObj(respId, model, created, fullText, tokens, "completed") });
          res.write("data: [DONE]\n\n");
          res.end();
        } catch {}
        writeProof({ path: "zen-responses", sessionID, model, ms: Date.now() - t0, chars: fullText.length, tokens, rotator: readRotatorTail(3), sample: fullText.slice(0, 160) });
        finish(null);
      }

      sub = subscribeEvents((evt) => {
        if (settled) return;
        const type = evt.type;
        const props = evt.properties || {};
        if (props.sessionID && props.sessionID !== sessionID) return;

        if (type === "message.updated") {
          const info = props.info || {};
          if (info.role === "assistant" && info.id) { assistantMsgId = info.id; if (info.tokens) tokens = info.tokens; }
        }

        if (type === "message.part.delta") {
          if (assistantMsgId && props.messageID && props.messageID !== assistantMsgId) return;
          if (props.field && props.field !== "text") return;
          const delta = props.delta || "";
          if (!delta) return;
          if (!assistantMsgId && props.messageID) assistantMsgId = props.messageID;
          fullText += delta;
          lastDeltaAt = Date.now();
          safeWrite({ type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta });
        }

        const isIdle =
          type === "session.idle" ||
          (type === "session.status" && props.status && props.status.type === "idle") ||
          (type === "session.updated" && props.session && props.session.time && props.session.time.completed);

        if (isIdle) { clearTimeout(timer); clearInterval(stallCheck); flushAndFinish(); }
      });

      await new Promise((r) => setTimeout(r, 80));
      const prompt = await callServe("POST", `/session/${sessionID}/prompt_async`, {
        model: { providerID: "opencode", modelID: model },
        parts: buildParts(chatBody),
      }, 15000);
      if (prompt.status !== 204 && prompt.status !== 200) {
        clearTimeout(timer); clearInterval(stallCheck);
        throw new Error("prompt_async failed: " + prompt.status + " " + (prompt.raw || "").slice(0, 200));
      }
    } catch (e) { finish(e); }
  });
}

async function zenResponsesOnce(model, chatBody) {
  const { openaiRes, sessionID, path: p } = await zenOnce(model, chatBody);
  const text = (((openaiRes.choices || [])[0] || {}).message || {}).content || "";
  const created = Math.floor(Date.now() / 1000);
  const itemId = "item_" + crypto.randomBytes(8).toString("hex");
  const respId = "resp_" + (openaiRes.id || crypto.randomBytes(12).toString("hex")).replace(/^chatcmpl-/, "");
  const tok = openaiRes.usage;
  return {
    responsesObj: {
      id: respId, object: "response", created_at: created, model, status: "completed",
      output: [{ type: "message", id: itemId, role: "assistant", content: [{ type: "output_text", text, annotations: [] }], status: "completed" }],
      usage: tok ? { input_tokens: tok.prompt_tokens || 0, output_tokens: tok.completion_tokens || 0, total_tokens: tok.total_tokens || 0 } : { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
    sessionID, path: p, text,
  };
}

// ── serve /event SSE subscriber ──────────────────────────────────────────────
function subscribeEvents(onEvent) {
  let closed = false;
  let currentReq = null;

  function connect() {
    if (closed) return;
    let buf = "";
    const sseAgent = new http.Agent({ keepAlive: false });
    const req = http.request({
      agent: sseAgent, hostname: SERVE_HOST, port: SERVE_PORT, path: "/event", method: "GET",
      headers: { authorization: AUTH, accept: "text/event-stream", connection: "keep-alive", "cache-control": "no-cache" },
    }, (res) => {
      res.on("data", (chunk) => {
        if (closed) return;
        buf += chunk.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            try { onEvent(JSON.parse(raw)); } catch {}
          }
        }
      });
      res.on("end", () => { if (!closed) setTimeout(connect, 200); });
      res.on("error", () => { if (!closed) setTimeout(connect, 500); });
    });
    req.on("error", () => { if (!closed) setTimeout(connect, 500); });
    req.end();
    currentReq = req;
  }

  connect();
  return { close() { closed = true; try { if (currentReq) currentReq.destroy(); } catch {} } };
}

function buildParts(body) {
  return (body.messages || []).map((m) => ({
    type: "text", text: messageText(m),
    id: "prt_" + crypto.randomBytes(12).toString("hex"),
  }));
}

// ── Chat completions SSE streaming ───────────────────────────────────────────
function zenStreamToClient(res, model, body, timeoutMs) {
  timeoutMs = timeoutMs || ZEN_TIMEOUT_MS;
  return new Promise(async (resolve, reject) => {
    const t0 = Date.now();
    let sessionID = null;
    let assistantMsgId = null;
    let fullText = "";
    let tokens = null;
    let settled = false;
    let sub = null;
    const chatId = "chatcmpl-" + crypto.randomBytes(8).toString("hex");

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (sub) sub.close();
      setTimeout(() => { if (sessionID) callServe("DELETE", `/session/${sessionID}`, null, 5000).catch(() => {}); }, 2000);

      if (err) {
        if (res.headersSent) {
          if (fullText === "") {
            // Idle-before-delta race: emit error content instead of blank
            try {
              res.write(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: "[zen: no response — model may be unavailable, try big-pickle or muse-spark-1.3-contributor-free]" }, finish_reason: "stop" }] })}\n\n`);
              res.write("data: [DONE]\n\n");
              res.end();
            } catch {}
            resolve({ sessionID, text: "", tokens, ms: Date.now() - t0, path: "zen-stream-notext", streamErr: err.message, chatId });
            return;
          }
          try {
            res.write(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          } catch {}
          resolve({ sessionID, text: fullText, tokens, ms: Date.now() - t0, path: "zen-stream-partial", streamErr: err.message });
        } else {
          reject(err);
        }
      } else {
        resolve({ sessionID, text: fullText, tokens, ms: Date.now() - t0, path: "zen-stream" });
      }
    };

    try {
      const session = await callServe("POST", "/session", { directory: null }, 15000);
      if (session.status !== 200 || !session.json || !session.json.id)
        throw new Error("serve session failed: " + session.status);
      sessionID = session.json.id;

      res.writeHead(200, {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive",
        ...proofHeaders({ "x-loophole-path": "zen-stream", "x-loophole-session": sessionID, "x-loophole-model": model }),
      });

      res.write(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);

      const timer = setTimeout(() => finish(new Error("zen stream timeout")), timeoutMs);

      let lastDeltaAt = Date.now();
      const stallCheck = setInterval(() => {
        if (settled) { clearInterval(stallCheck); return; }
        if (fullText.length > 0 && Date.now() - lastDeltaAt > 15000) {
          clearInterval(stallCheck); clearTimeout(timer);
          if (!res.headersSent) return;
          try {
            res.write(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          } catch {}
          writeProof({ path: "zen-stream-stall", sessionID, model, ms: Date.now() - t0, chars: fullText.length, tokens, rotator: readRotatorTail(3), sample: fullText.slice(0, 160) });
          finish(null);
        }
      }, 2000);

      sub = subscribeEvents((evt) => {
        if (settled) return;
        const type = evt.type;
        const props = evt.properties || {};
        if (props.sessionID && props.sessionID !== sessionID) return;

        if (type === "message.updated") {
          const info = props.info || {};
          if (info.role === "assistant" && info.id) { assistantMsgId = info.id; if (info.tokens) tokens = info.tokens; }
        }

        if (type === "message.part.delta") {
          if (assistantMsgId && props.messageID && props.messageID !== assistantMsgId) return;
          if (props.field && props.field !== "text") return;
          const delta = props.delta || "";
          if (!delta) return;
          if (!assistantMsgId && props.messageID) assistantMsgId = props.messageID;
          fullText += delta;
          lastDeltaAt = Date.now();
          try {
            res.write(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`);
          } catch {}
        }

        const isIdle =
          type === "session.idle" ||
          (type === "session.status" && props.status && props.status.type === "idle") ||
          (type === "session.updated" && props.session && props.session.time && props.session.time.completed);

        if (isIdle) {
          clearTimeout(timer); clearInterval(stallCheck);
          // Idle-before-delta race: wait up to 2s for late-arriving deltas before giving up
          if (fullText === "") {
            setTimeout(() => {
              if (settled) return;
              if (fullText === "") {
                console.error("Zen Bridge: idle-before-delta for", model, "— no text after 2s wait, error response");
                finish(new Error("idle-with-no-text"));
              } else {
                // Text arrived during wait — close normally
                try {
                  res.write(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
                  res.write("data: [DONE]\n\n");
                  res.end();
                } catch {}
                writeProof({ path: "zen-stream", sessionID, model, ms: Date.now() - t0, chars: fullText.length, tokens, rotator: readRotatorTail(3), sample: fullText.slice(0, 160) });
                finish(null);
              }
            }, 2000);
            return;
          }
          try {
            res.write(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          } catch {}
          writeProof({ path: "zen-stream", sessionID, model, ms: Date.now() - t0, chars: fullText.length, tokens, rotator: readRotatorTail(3), sample: fullText.slice(0, 160) });
          finish(null);
        }
      });

      await new Promise((r) => setTimeout(r, 80));
      const prompt = await callServe("POST", `/session/${sessionID}/prompt_async`, {
        model: { providerID: "opencode", modelID: model },
        parts: buildParts(body),
      }, 15000);
      if (prompt.status !== 204 && prompt.status !== 200) {
        clearTimeout(timer); clearInterval(stallCheck);
        throw new Error("prompt_async failed: " + prompt.status + " " + (prompt.raw || "").slice(0, 200));
      }
    } catch (e) { finish(e); }
  });
}

// ── Non-stream: sync /message ─────────────────────────────────────────────────
async function zenOnce(model, body) {
  const session = await callServe("POST", "/session", { directory: null }, 15000);
  if (session.status !== 200 || !session.json || !session.json.id)
    throw Object.assign(new Error("serve session failed: " + session.status), { status: session.status });
  const sessionID = session.json.id;
  try {
    const msg = await callServe("POST", `/session/${sessionID}/message`, {
      model: { providerID: "opencode", modelID: model },
      parts: buildParts(body),
    }, ZEN_TIMEOUT_MS);
    if (msg.status !== 200)
      throw Object.assign(new Error("serve message failed: " + msg.status + " " + (msg.raw || "").slice(0, 200)), { status: msg.status });
    if (msg.json && msg.json.name === "UnknownError")
      throw Object.assign(new Error("serve UnknownError: " + ((msg.json.data && msg.json.data.message) || "")), { status: 500 });
    if (msg.json && msg.json.info && msg.json.info.error)
      throw Object.assign(new Error("serve model error: " + JSON.stringify(msg.json.info.error).slice(0, 240)), { status: 502 });

    const parts = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.type === "text" && typeof node.text === "string") parts.push(node.text);
      if (node.parts) walk(node.parts);
    };
    walk(msg.json);
    const text = parts.join("");
    const openaiRes = {
      id: "chatcmpl-" + (msg.json.info && msg.json.info.id ? msg.json.info.id : crypto.randomBytes(8).toString("hex")),
      object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: msg.json.info && msg.json.info.tokens
        ? { prompt_tokens: msg.json.info.tokens.input || msg.json.info.tokens.prompt, completion_tokens: msg.json.info.tokens.output || msg.json.info.tokens.completion, total_tokens: msg.json.info.tokens.total }
        : undefined,
      system_fingerprint: sessionID,
    };
    writeProof({ path: "zen-sync", sessionID, model, tokens: msg.json.info && msg.json.info.tokens, rotator: readRotatorTail(3), sample: text.slice(0, 160) });
    return { openaiRes, sessionID, path: "zen-sync" };
  } finally {
    callServe("DELETE", `/session/${sessionID}`, null, 5000).catch(() => {});
  }
}

// ── handleChat ───────────────────────────────────────────────────────────────
async function handleChat(res, body, stream) {
  const resolved = resolveZenModel(body.model);
  const requested = resolved.requested;
  let zenModel = resolved.zenModel;
  let remapped = resolved.remapped;

  if (FAST_ZEN.has(requested)) { zenModel = requested; remapped = false; }

  const tryZen = async (model, tag, timeoutOverride) => {
    if (stream) {
      const meta = await zenStreamToClient(res, model, body, timeoutOverride);
      return { path: meta.path || tag, model, requested, remapped: model !== requested, ...meta };
    }
    const result = await zenOnce(model, body);
    res.writeHead(200, {
      "Content-Type": "application/json",
      ...proofHeaders({ "x-loophole-path": tag, "x-loophole-session": result.sessionID || "", "x-loophole-model": model, "x-loophole-requested": requested, "x-loophole-remapped": model !== requested ? "1" : "0" }),
    });
    res.end(JSON.stringify(result.openaiRes));
    return { path: tag, model, requested, remapped: model !== requested };
  };

  try {
    const zenTimeout = (remapped || !FAST_ZEN.has(requested)) ? ZEN_REMAP_TIMEOUT_MS : ZEN_TIMEOUT_MS;
    const meta = await tryZen(requested, remapped ? "zen-remap" : "zen-live", zenTimeout);
    return meta;
  } catch (e1) {
    if (stream && res.headersSent)
      return { path: "zen-stream-partial", model: zenModel, requested, remapped, streamErr: e1.message };

    // Try the remapped live model if different
    if (zenModel !== requested) {
      try {
        console.error("Zen Bridge: exact failed for", requested, "-> remap", zenModel, e1.message);
        return await tryZen(zenModel, "zen-remap");
      } catch (e2) {
        console.error("Zen Bridge: remap also failed:", e2.message);
        if (stream && res.headersSent)
          return { path: "zen-remap-partial", model: zenModel, requested, remapped, streamErr: e2.message };
      }
    }

    // Both paths failed — return error
    const errMsg = "zen failed for " + requested + ": " + e1.message;
    console.error("Zen Bridge:", errMsg);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json", ...proofHeaders() });
      res.end(JSON.stringify({ error: { message: errMsg, type: "zen_error" } }));
    }
    return { path: "zen-error", model: zenModel, requested, remapped, error: errMsg };
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.on("error", () => {});
  const urlPath = (req.url || "/").split("?")[0];

  if ((urlPath === "/v1/models" || urlPath === "/models") && req.method === "GET") {
    const models = [
      { id: "opencode/fast", object: "model", created: 0, owned_by: "opencode" },
      { id: "opencode/fastest", object: "model", created: 0, owned_by: "opencode" },
      ...WHITELIST.map((id) => ({ id: "opencode/" + id, object: "model", created: 0, owned_by: "opencode" })),
    ];
    res.writeHead(200, { "Content-Type": "application/json", ...proofHeaders() });
    return res.end(JSON.stringify({ object: "list", data: models }));
  }

  if (urlPath === "/health" || urlPath === "/v1/health") {
    res.writeHead(200, { "Content-Type": "application/json", ...proofHeaders() });
    return res.end(JSON.stringify({
      ok: true, real: true, simulation: false, service: "bridge",
      uptime: process.uptime(), fastRace: FAST_RACE,
      streaming: "serve-/event-message.part.delta",
      upstream: "opencode.ai/zen/v1 via rotator:1341",
      defaultZen: "big-pickle",
    }));
  }

  if (urlPath === "/v1/proof" || urlPath === "/proof") {
    res.writeHead(200, { "Content-Type": "application/json", ...proofHeaders() });
    return res.end(JSON.stringify({
      ok: true, real: true, simulation: false, last: lastProof,
      rotatorRecent: readRotatorTail(10),
      chain: lastProof.chain || ["opencode-client", "bridge:1343", "serve:18765", "rotator:1341", "opencode.ai/zen/v1"],
    }));
  }

  if (urlPath === "/activity" && req.method === "GET") {
    try {
      const raw = fs.existsSync(ACTIVITY_LOG) ? fs.readFileSync(ACTIVITY_LOG, "utf8") : "";
      const lines = raw.split(/\r?\n/).filter(Boolean).slice(-200);
      const data = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, entries: data }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if ((urlPath === "/v1/chat/completions" || urlPath === "/chat/completions" || urlPath === "/v1/messages") && req.method === "POST") {
    let chunks = "";
    const started = Date.now();
    req.on("data", (c) => { chunks += c; });
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(chunks || "{}"); } catch {}
      const model = body.model || "big-pickle";
      const streamReq = !!body.stream;
      const t0 = Date.now();
      handleChat(res, body, streamReq)
        .then((meta) => {
          logActivity({ event: "completion", model, resolved: meta && meta.model, path: meta && meta.path, stream: streamReq, status: 200, ms: Date.now() - t0, reqMs: t0 - started, real: true });
        })
        .catch((e) => {
          logActivity({ event: "completion", model, stream: streamReq, status: e.status || 500, ms: Date.now() - t0, reqMs: t0 - started, error: e.message, real: true });
          if (!res.headersSent) {
            res.writeHead(e.status || 500, { "Content-Type": "application/json", ...proofHeaders() });
            res.end(JSON.stringify({ error: { message: "bridge: " + e.message } }));
          }
        });
    });
    return;
  }

  // ── /v1/responses — OpenAI Responses API ──────────────────────────────────
  if (urlPath === "/v1/responses" && req.method === "POST") {
    let chunks = "";
    const started = Date.now();
    req.on("data", (c) => { chunks += c; });
    req.on("end", () => {
      let rawBody = {};
      try { rawBody = JSON.parse(chunks || "{}"); } catch {}
      const chatBody = responsesBodyToChatBody(rawBody);
      const model = chatBody.model || "big-pickle";
      const streamReq = !!rawBody.stream;
      const t0 = Date.now();

      const resolved = resolveZenModel(model);
      const zenModel = FAST_ZEN.has(resolved.requested) ? resolved.requested : resolved.zenModel;

      const doRequest = async () => {
        const tryZenResponses = async (mdl, timeoutOverride) => {
          if (streamReq) return await zenStreamResponsesToClient(res, mdl, chatBody, timeoutOverride);
          const result = await zenResponsesOnce(mdl, chatBody);
          res.writeHead(200, { "Content-Type": "application/json", ...proofHeaders({ "x-loophole-path": result.path, "x-loophole-model": mdl }) });
          res.end(JSON.stringify(result.responsesObj));
          return result;
        };

        const zenRespTimeout = FAST_ZEN.has(resolved.requested) ? ZEN_TIMEOUT_MS : ZEN_REMAP_TIMEOUT_MS;

        try {
          return await tryZenResponses(resolved.requested, zenRespTimeout);
        } catch (e1) {
          if (streamReq && res.headersSent)
            return { path: "zen-responses-partial", model: zenModel, streamErr: e1.message };

          // Remap fallback
          if (zenModel !== resolved.requested) {
            try {
              console.error("Zen Bridge /v1/responses: exact failed for", resolved.requested, "-> remap", zenModel, e1.message);
              return await tryZenResponses(zenModel);
            } catch (e2) {
              console.error("Zen Bridge /v1/responses remap failed:", e2.message);
            }
          }

          // Both failed — return error response
          const errMsg = "zen failed for " + resolved.requested + ": " + e1.message;
          console.error("Zen Bridge /v1/responses:", errMsg);
          if (!res.headersSent) {
            if (streamReq) {
              // Emit error as a proper Responses API stream so the SDK doesn't hang
              const rid = "resp_err_" + Date.now().toString(16);
              const iid = "item_err_" + Date.now().toString(16);
              const ts = Math.floor(Date.now() / 1000);
              const errText = "[zen error: " + errMsg + "]";
              res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...proofHeaders() });
              const sw = (obj) => { try { res.write("event: " + obj.type + "\ndata: " + JSON.stringify(obj) + "\n\n"); } catch {} };
              sw({ type: "response.created", response: { id: rid, object: "response", created_at: ts, model, status: "in_progress", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
              sw({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: iid, role: "assistant", content: [], status: "in_progress" } });
              sw({ type: "response.content_part.added", item_id: iid, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
              sw({ type: "response.output_text.delta", item_id: iid, output_index: 0, content_index: 0, delta: errText });
              sw({ type: "response.output_text.done", item_id: iid, output_index: 0, content_index: 0, text: errText });
              sw({ type: "response.content_part.done", item_id: iid, output_index: 0, content_index: 0, part: { type: "output_text", text: errText, annotations: [] } });
              sw({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: iid, role: "assistant", content: [{ type: "output_text", text: errText, annotations: [] }], status: "completed" } });
              sw({ type: "response.completed", response: { id: rid, object: "response", created_at: ts, model, status: "completed", output: [{ type: "message", id: iid, role: "assistant", content: [{ type: "output_text", text: errText, annotations: [] }], status: "completed" }], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
              res.write("data: [DONE]\n\n"); res.end();
            } else {
              res.writeHead(502, { "Content-Type": "application/json", ...proofHeaders() });
              res.end(JSON.stringify({ error: { message: errMsg, type: "zen_error" } }));
            }
          }
          return { path: "zen-responses-error", model: zenModel, error: errMsg };
        }
      };

      doRequest()
        .then((meta) => {
          logActivity({ event: "completion", api: "responses", model, resolved: meta && meta.model, path: meta && meta.path, stream: streamReq, status: 200, ms: Date.now() - t0, reqMs: t0 - started, real: true });
        })
        .catch((e) => {
          logActivity({ event: "completion", api: "responses", model, stream: streamReq, status: e.status || 500, ms: Date.now() - t0, reqMs: t0 - started, error: e.message, real: true });
          if (!res.headersSent) {
            res.writeHead(e.status || 500, { "Content-Type": "application/json", ...proofHeaders() });
            res.end(JSON.stringify({ error: { message: "bridge: " + e.message } }));
          }
        });
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "bridge: unknown path " + urlPath } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Zen bridge REAL (no g4f): http://127.0.0.1:${PORT} -> serve :${SERVE_PORT} -> rotator -> opencode.ai | stream=live-deltas`);
});
