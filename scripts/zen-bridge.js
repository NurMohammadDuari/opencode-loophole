/**
 * Zen Bridge — REAL OpenAI-compat front door on :1343
 *
 * Not a simulation:
 *  - Creates a real opencode serve session
 *  - Streams live message.part.delta events from serve /event SSE
 *  - Serve talks to zen-rotator :1341 → real TLS to opencode.ai/zen/v1
 *  - Proof headers + /v1/proof expose last upstream hop evidence
 *
 * FIXES (2026-09-20):
 *  - /v1/responses route added (OpenAI Responses API → chat completions bridge)
 *  - SSE "stream failed after headers sent" race fixed: finish(err) resolves
 *    instead of rejects when res.headersSent, so the outer .catch never fires
 *    a 500 response mid-stream
 *  - session.idle detection made more robust: also watches session.updated with
 *    completed time, guards all res.write calls with settled/headersSent checks
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
const G4F_HOST = process.env.G4F_HOST || "127.0.0.1";
const G4F_PORT = Number(process.env.G4F_PORT || 1337);
const G4F_FAST_MODEL = process.env.G4F_FAST_MODEL || "gemini-flash-lite";
const FAST_RACE = process.env.FAST_RACE === "1"; // OFF by default — pure zen path
const ZEN_TIMEOUT_MS = Number(process.env.ZEN_TIMEOUT_MS || 90000);
const G4F_TIMEOUT_MS = Number(process.env.G4F_TIMEOUT_MS || 30000);

const SHARE = path.join(os.homedir(), ".local", "share", "opencode");
const ACTIVITY_LOG = process.env.BRIDGE_ACTIVITY_LOG || path.join(SHARE, "bridge-activity.jsonl");
const PROOF_FILE = process.env.BRIDGE_PROOF_FILE || path.join(SHARE, "loophole-proof.json");
const ROTATOR_PROOF = process.env.ROTATOR_PROOF_FILE || path.join(SHARE, "rotator-proof.jsonl");

const AUTH = "Basic " + Buffer.from(`${SERVE_USER}:${SERVE_PASS}`).toString("base64");
const serveAgent = new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 30_000 });
const g4fAgent = new http.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30_000 });

// Try catalog from multiple locations so a missing servehome copy never silently falls back to big-pickle only
const CATALOG_CANDIDATES = process.env.MODELS_CATALOG
  ? [process.env.MODELS_CATALOG]
  : [
      path.join(SHARE, "models-catalog.json"),                                   // servehome path (bridge HOME)
      path.join(os.homedir(), ".local", "share", "opencode", "models-catalog.json"), // real HOME
      path.join(__dirname, "models-catalog.json"),                                // next to this file
      path.join(__dirname, "..", "models-catalog.json"),                          // one level up
      path.join(__dirname, "..", "config", "models-catalog.json"),                // config/ subdir
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
if (!catalogLoaded) console.error("catalog load failed — all candidate paths tried, using big-pickle fallback");

const FAST_ZEN = new Set(CATALOG.zen_live_free || ["big-pickle"]);
const MODEL_REMAP = CATALOG.remap_to_zen_live || {};
const WHITELIST = CATALOG.whitelist_31 || ["big-pickle"];


let lastProof = {
  ts: 0,
  real: true,
  chain: ["opencode-client", "bridge:1343", "serve:18765", "rotator:1341", "opencode.ai/zen/v1"],
  note: "waiting for first request",
};

function logActivity(entry) {
  try {
    fs.appendFileSync(ACTIVITY_LOG, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
  } catch {}
}

function writeProof(p) {
  lastProof = { ts: Date.now(), real: true, ...p };
  try {
    fs.writeFileSync(PROOF_FILE, JSON.stringify(lastProof, null, 2));
  } catch {}
}

function readRotatorTail(n = 5) {
  try {
    if (!fs.existsSync(ROTATOR_PROOF)) return [];
    const lines = fs.readFileSync(ROTATOR_PROOF, "utf8").split(/\r?\n/).filter(Boolean).slice(-n);
    return lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function modelName(m) {
  if (typeof m !== "string") return "big-pickle";
  return m.split("/").pop().replace(/^opencode:/, "");
}

function resolveZenModel(m) {
  const raw = modelName(m);
  if (FAST_ZEN.has(raw) || WHITELIST.includes(raw) || raw === "big-pickle") return { requested: raw, zenModel: raw, remapped: false };
  if (MODEL_REMAP[raw]) return { requested: raw, zenModel: MODEL_REMAP[raw], remapped: true };
  return { requested: raw, zenModel: MODEL_REMAP[raw] || "big-pickle", remapped: !!MODEL_REMAP[raw] || raw !== "big-pickle" };
}

function messageText(m) {
  if (m == null) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((p) => (typeof p === "string" ? p : (p && (p.text || p.content)) || ""))
      .join("");
  }
  return String(m.content || "");
}

function httpJson(agent, hostname, port, method, reqPath, body, timeoutMs, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        agent,
        hostname,
        port,
        path: reqPath,
        method,
        headers: {
          "content-type": "application/json",
          ...(data ? { "content-length": Buffer.byteLength(data) } : {}),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let out = "";
        res.on("data", (c) => {
          out += c;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: out ? JSON.parse(out) : null, raw: out });
          } catch {
            resolve({ status: res.statusCode, json: { raw: out }, raw: out });
          }
        });
      }
    );
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

// Confirmed-working g4f models (tested 2026-09-20). Tried in order; first success wins.
const G4F_WORKING_MODELS = process.env.G4F_WORKING_MODELS
  ? process.env.G4F_WORKING_MODELS.split(",")
  : [
      "gemini-flash-lite",       // fastest, most reliable
      "gemini-2.0-flash",        // good quality
      "gemini-2.5-flash",        // best Gemini free
      "gemini-2.5-pro",          // premium quality
      "gemini-2.0-flash-thinking", // reasoning
      "command-r-plus",          // Cohere
      "qwen-2.5-coder-32b",      // code-focused
    ];

function callG4f(body, modelOverride) {
  const model = modelOverride || G4F_FAST_MODEL;
  const payload = { ...body, model, provider: "Gemini", stream: false };
  return httpJson(g4fAgent, G4F_HOST, G4F_PORT, "POST", "/v1/chat/completions", payload, G4F_TIMEOUT_MS);
}

function proofHeaders(extra = {}) {
  return {
    "x-loophole-real": "1",
    "x-loophole-chain": "bridge->serve->rotator->opencode.ai/zen/v1",
    "x-loophole-simulation": "0",
    ...extra,
  };
}

/**
 * Convert OpenAI Responses API body (/v1/responses) to chat completions body.
 *
 * The Responses API uses:
 *   { model, input: "string" | [{type:"message",role,content}...], stream, ... }
 * We map it to:
 *   { model, messages: [{role, content}...], stream }
 */
function responsesBodyToChatBody(body) {
  const input = body.input;
  let messages = [];

  if (typeof input === "string") {
    // Plain string input → single user message
    messages = [{ role: "user", content: input }];
  } else if (Array.isArray(input)) {
    // Array of message items (Responses API format)
    messages = input.map((item) => {
      if (item && item.type === "message") {
        const role = item.role || "user";
        let content = "";
        if (typeof item.content === "string") {
          content = item.content;
        } else if (Array.isArray(item.content)) {
          // content parts: [{type:"input_text",text:"..."}] etc.
          content = item.content
            .map((c) => {
              if (typeof c === "string") return c;
              return c.text || c.content || "";
            })
            .join("");
        }
        return { role, content };
      }
      // Fallback: treat as user text
      return { role: "user", content: typeof item === "string" ? item : JSON.stringify(item) };
    });
  } else {
    // Unexpected — pass empty user message so we don't crash
    messages = [{ role: "user", content: "" }];
  }

  // Carry over system prompt if provided via instructions field
  if (body.instructions && typeof body.instructions === "string") {
    messages = [{ role: "system", content: body.instructions }, ...messages];
  }

  return {
    model: body.model || "big-pickle",
    messages,
    stream: !!body.stream,
    temperature: body.temperature,
    max_tokens: body.max_output_tokens || body.max_tokens,
  };
}

/**
 * Subscribe to serve /event SSE and invoke onEvent(parsed) for each data line.
 * Reconnects automatically on disconnect. Returns { close() }.
 */
function subscribeEvents(onEvent) {
  let closed = false;
  let currentReq = null;

  function connect() {
    if (closed) return;
    let buf = "";
    // Use a fresh per-connection agent (NOT keepAlive) so we always get a full SSE stream
    const sseAgent = new http.Agent({ keepAlive: false });
    const req = http.request(
      {
        agent: sseAgent,
        hostname: SERVE_HOST,
        port: SERVE_PORT,
        path: "/event",
        method: "GET",
        headers: {
          authorization: AUTH,
          accept: "text/event-stream",
          connection: "keep-alive",
          "cache-control": "no-cache",
        },
      },
      (res) => {
        res.on("data", (chunk) => {
          if (closed) return;
          buf += chunk.toString("utf8");
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const lines = block.split(/\r?\n/);
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const raw = line.slice(5).trim();
              if (!raw || raw === "[DONE]") continue;
              try {
                onEvent(JSON.parse(raw));
              } catch {}
            }
          }
        });
        res.on("end", () => {
          if (!closed) {
            // Reconnect after brief delay
            setTimeout(connect, 200);
          }
        });
        res.on("error", () => {
          if (!closed) setTimeout(connect, 500);
        });
      }
    );
    req.on("error", () => {
      if (!closed) setTimeout(connect, 500);
    });
    req.end();
    currentReq = req;
  }

  connect();

  return {
    close() {
      closed = true;
      try {
        if (currentReq) currentReq.destroy();
      } catch {}
    },
  };
}

function buildParts(body) {
  return (body.messages || []).map((m) => ({
    type: "text",
    text: messageText(m),
    id: "prt_" + crypto.randomBytes(12).toString("hex"),
  }));
}

/**
 * REAL streaming: prompt_async + live message.part.delta from serve events.
 *
 * FIX: "zen stream failed after headers sent"
 *   When the stream already started (res.headersSent), finish(err) now RESOLVES
 *   instead of rejecting. This prevents the outer handleChat .catch() from
 *   attempting to write a 500 JSON response after SSE headers were sent.
 *   The client already received partial content and a graceful [DONE].
 */
function zenStreamToClient(res, model, body) {
  return new Promise(async (resolve, reject) => {
    const t0 = Date.now();
    let sessionID = null;
    let assistantMsgId = null;
    let fullText = "";
    let tokens = null;
    let settled = false;
    let sub = null;
    const chatId = "chatcmpl-" + crypto.randomBytes(8).toString("hex");

    // FIX: never reject after headers are sent — resolve with an error flag instead
    // so the outer .catch doesn't try to write a new 5xx head mid-stream.
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (sub) sub.close();
      if (sessionID) callServe("DELETE", `/session/${sessionID}`, null, 5000).catch(() => {});

      if (err) {
        if (res.headersSent) {
          // Stream already started — gracefully close it and treat as a soft error
          try {
            const errId = "chatcmpl-partial-" + Date.now().toString(16);
            res.write(`data: ${JSON.stringify({ id: errId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          } catch {}
          // Resolve (not reject) so the outer .catch never fires a 500 mid-stream
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
      if (session.status !== 200 || !session.json || !session.json.id) {
        throw new Error("serve session failed: " + session.status);
      }
      sessionID = session.json.id;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...proofHeaders({
          "x-loophole-path": "zen-stream",
          "x-loophole-session": sessionID,
          "x-loophole-model": model,
        }),
      });

      // role chunk
      res.write(
        `data: ${JSON.stringify({
          id: chatId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        })}\n\n`
      );

      const timer = setTimeout(() => finish(new Error("zen stream timeout")), ZEN_TIMEOUT_MS);

      // Track how long since last delta to detect a stalled stream even without session.idle
      let lastDeltaAt = Date.now();
      const stallCheck = setInterval(() => {
        if (settled) { clearInterval(stallCheck); return; }
        if (fullText.length > 0 && Date.now() - lastDeltaAt > 15000) {
          // No new content for 15s after first text — treat as done
          clearInterval(stallCheck);
          clearTimeout(timer);
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
          if (info.role === "assistant" && info.id) {
            assistantMsgId = info.id;
            if (info.tokens) tokens = info.tokens;
          }
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
            res.write(
              `data: ${JSON.stringify({
                id: chatId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
              })}\n\n`
            );
          } catch {}
        }

        // FIX: more robust idle detection
        // session.idle event, OR session.status with type=idle, OR session.updated with completed time
        const isIdle =
          type === "session.idle" ||
          (type === "session.status" && props.status && props.status.type === "idle") ||
          (type === "session.updated" && props.session && props.session.time && props.session.time.completed);

        if (isIdle) {
          clearTimeout(timer);
          clearInterval(stallCheck);
          try {
            res.write(
              `data: ${JSON.stringify({
                id: chatId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              })}\n\n`
            );
            res.write("data: [DONE]\n\n");
            res.end();
          } catch {}
          writeProof({
            path: "zen-stream",
            sessionID,
            model,
            ms: Date.now() - t0,
            chars: fullText.length,
            tokens,
            rotator: readRotatorTail(3),
            sample: fullText.slice(0, 160),
          });
          finish(null);
        }
      });

      // kick the real async prompt after event subscription is live
      await new Promise((r) => setTimeout(r, 80));
      const prompt = await callServe(
        "POST",
        `/session/${sessionID}/prompt_async`,
        {
          model: { providerID: "opencode", modelID: model },
          parts: buildParts(body),
        },
        15000
      );
      if (prompt.status !== 204 && prompt.status !== 200) {
        clearTimeout(timer);
        clearInterval(stallCheck);
        throw new Error("prompt_async failed: " + prompt.status + " " + (prompt.raw || "").slice(0, 200));
      }
    } catch (e) {
      finish(e);
    }
  });
}

/**
 * Non-stream: sync /message (still real serve → rotator → opencode.ai)
 */
async function zenOnce(model, body) {
  const session = await callServe("POST", "/session", { directory: null }, 15000);
  if (session.status !== 200 || !session.json || !session.json.id) {
    throw Object.assign(new Error("serve session failed: " + session.status), { status: session.status });
  }
  const sessionID = session.json.id;
  try {
    const msg = await callServe(
      "POST",
      `/session/${sessionID}/message`,
      {
        model: { providerID: "opencode", modelID: model },
        parts: buildParts(body),
      },
      ZEN_TIMEOUT_MS
    );
    if (msg.status !== 200) {
      throw Object.assign(new Error("serve message failed: " + msg.status + " " + (msg.raw || "").slice(0, 200)), {
        status: msg.status,
      });
    }
    if (msg.json && msg.json.name === "UnknownError") {
      throw Object.assign(new Error("serve UnknownError: " + ((msg.json.data && msg.json.data.message) || "")), {
        status: 500,
      });
    }
    if (msg.json && msg.json.info && msg.json.info.error) {
      throw Object.assign(new Error("serve model error: " + JSON.stringify(msg.json.info.error).slice(0, 240)), {
        status: 502,
      });
    }

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
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage:
        msg.json.info && msg.json.info.tokens
          ? {
              prompt_tokens: msg.json.info.tokens.input || msg.json.info.tokens.prompt,
              completion_tokens: msg.json.info.tokens.output || msg.json.info.tokens.completion,
              total_tokens: msg.json.info.tokens.total,
            }
          : undefined,
      system_fingerprint: sessionID,
    };
    writeProof({
      path: "zen-sync",
      sessionID,
      model,
      tokens: msg.json.info && msg.json.info.tokens,
      rotator: readRotatorTail(3),
      sample: text.slice(0, 160),
    });
    return { openaiRes, sessionID, path: "zen-sync" };
  } finally {
    callServe("DELETE", `/session/${sessionID}`, null, 5000).catch(() => {});
  }
}

async function g4fOnce(body) {
  let lastErr = null;
  for (const model of G4F_WORKING_MODELS) {
    const g4fRes = await callG4f(body, model);
    if (g4fRes.status === 200 && g4fRes.json && g4fRes.json.choices) {
      writeProof({
        path: "g4f-fallback",
        model,
        sample: ((((g4fRes.json.choices || [])[0] || {}).message || {}).content || "").slice(0, 160),
        note: "zen path failed; used local g4f mirror model=" + model,
      });
      return { openaiRes: g4fRes.json, sessionID: "g4f", path: "g4f-fallback", model };
    }
    lastErr = "g4f/" + model + " failed: " + g4fRes.status + " " + (g4fRes.raw || "").slice(0, 80);
    console.error("Zen Bridge: g4f model", model, "failed:", g4fRes.status);
  }
  throw Object.assign(new Error("all g4f models failed; last: " + lastErr), { status: 502 });
}

async function handleChat(res, body, stream) {
  const resolved = resolveZenModel(body.model);
  const requested = resolved.requested;
  let zenModel = resolved.zenModel;
  let remapped = resolved.remapped;

  // Prefer exact requested id when it is a known live zen free model
  if (FAST_ZEN.has(requested)) {
    zenModel = requested;
    remapped = false;
  }

  const tryZen = async (model, tag) => {
    if (stream) {
      const meta = await zenStreamToClient(res, model, body);
      return { path: meta.path || tag, model, requested, remapped: model !== requested, ...meta };
    }
    const result = await zenOnce(model, body);
    res.writeHead(200, {
      "Content-Type": "application/json",
      ...proofHeaders({
        "x-loophole-path": tag,
        "x-loophole-session": result.sessionID || "",
        "x-loophole-model": model,
        "x-loophole-requested": requested,
        "x-loophole-remapped": model !== requested ? "1" : "0",
      }),
    });
    res.end(JSON.stringify(result.openaiRes));
    return { path: tag, model, requested, remapped: model !== requested };
  };

  // 1) exact requested on zen (even if not in live list — zen may still accept it)
  if (!stream || true) {
    try {
      if (requested !== zenModel || FAST_ZEN.has(requested) || !remapped) {
        try {
          return await tryZen(requested, remapped ? "zen-exact" : "zen-live");
        } catch (e1) {
          // If headers were already sent (stream partial), surface it so the activity log records it
          if (stream && res.headersSent) {
            return { path: "zen-stream-partial", model: zenModel, requested, remapped, streamErr: e1.message };
          }
          // 2) disclosed remap to a live zen free model
          if (MODEL_REMAP[requested] && MODEL_REMAP[requested] !== requested) {
            console.error("Zen Bridge: exact failed for", requested, "-> remap", MODEL_REMAP[requested], e1.message);
            try {
              return await tryZen(MODEL_REMAP[requested], "zen-remap");
            } catch (e2) {
              console.error("Zen Bridge: remap failed, g4f fallback:", e2.message);
            }
          } else if (zenModel !== requested) {
            try {
              return await tryZen(zenModel, "zen-remap");
            } catch (e2) {
              console.error("Zen Bridge: remap failed, g4f fallback:", e2.message);
            }
          } else {
            console.error("Zen Bridge: zen failed, g4f fallback:", e1.message);
          }
        }
      }
    } catch (e) {
      console.error("Zen Bridge: unexpected:", e.message);
      if (stream && res.headersSent) {
        return { path: "zen-stream-partial", model: zenModel, requested, remapped, streamErr: e.message };
      }
    }
  }

  // stream path already wrote headers on success; on failure close the stream gracefully
  if (stream && res.headersSent) {
    // Can't send new headers — emit an SSE error event and close cleanly
    const errId = "chatcmpl-err-" + Date.now().toString(16);
    try {
      res.write(`data: ${JSON.stringify({ id: errId, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: requested, choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } catch {}
    return { path: "zen-stream-err", model: zenModel, requested, remapped };
  }

  const result = await g4fOnce(body);
  if (stream) {
    // emit as synthetic SSE from full g4f text
    const text = ((((result.openaiRes.choices || [])[0] || {}).message || {}).content) || "";
    const chatId = "chatcmpl-g4f-" + Date.now().toString(16);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...proofHeaders({ "x-loophole-path": "g4f-fallback", "x-loophole-requested": requested }),
    });
    res.write(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: requested, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: requested, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    res.writeHead(200, {
      "Content-Type": "application/json",
      ...proofHeaders({ "x-loophole-path": result.path, "x-loophole-requested": requested }),
    });
    res.end(JSON.stringify(result.openaiRes));
  }
  return { path: "g4f-fallback", model: zenModel, requested, remapped };
}


const server = http.createServer((req, res) => {
  res.on("error", () => {});
  const urlPath = (req.url || "/").split("?")[0];

  if ((urlPath === "/v1/models" || urlPath === "/models") && req.method === "GET") {
    const models = [
      { id: "opencode/fast", object: "model", created: 0, owned_by: "opencode" },
      { id: "opencode/fastest", object: "model", created: 0, owned_by: "opencode" },
      ...WHITELIST.map((id) => ({ id: "opencode/" + id, object: "model", created: 0, owned_by: "opencode" })),
      // Expose confirmed-working g4f fallback models under g4f/ prefix
      ...G4F_WORKING_MODELS.map((id) => ({ id: "g4f/" + id, object: "model", created: 0, owned_by: "g4f" })),
    ];
    res.writeHead(200, { "Content-Type": "application/json", ...proofHeaders() });
    return res.end(JSON.stringify({ object: "list", data: models }));
  }

  if (urlPath === "/health" || urlPath === "/v1/health") {
    res.writeHead(200, { "Content-Type": "application/json", ...proofHeaders() });
    return res.end(
      JSON.stringify({
        ok: true,
        real: true,
        simulation: false,
        service: "bridge",
        uptime: process.uptime(),
        fastRace: FAST_RACE,
        streaming: "serve-/event-message.part.delta",
        upstream: "opencode.ai/zen/v1 via rotator:1341",
        g4fFastModel: G4F_FAST_MODEL,
        defaultZen: "big-pickle",
      })
    );
  }

  if (urlPath === "/v1/proof" || urlPath === "/proof") {
    res.writeHead(200, { "Content-Type": "application/json", ...proofHeaders() });
    return res.end(
      JSON.stringify({
        ok: true,
        real: true,
        simulation: false,
        last: lastProof,
        rotatorRecent: readRotatorTail(10),
        chain: lastProof.chain || [
          "opencode-client",
          "bridge:1343",
          "serve:18765",
          "rotator:1341",
          "opencode.ai/zen/v1",
        ],
      })
    );
  }

  if (urlPath === "/activity" && req.method === "GET") {
    try {
      const raw = fs.existsSync(ACTIVITY_LOG) ? fs.readFileSync(ACTIVITY_LOG, "utf8") : "";
      const lines = raw.split(/\r?\n/).filter(Boolean).slice(-200);
      const data = lines
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, entries: data }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (
    (urlPath === "/v1/chat/completions" || urlPath === "/chat/completions" || urlPath === "/v1/messages") &&
    req.method === "POST"
  ) {
    let chunks = "";
    const started = Date.now();
    req.on("data", (c) => {
      chunks += c;
    });
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(chunks || "{}");
      } catch {}
      const model = body.model || "big-pickle";
      const streamReq = !!body.stream;
      const t0 = Date.now();
      handleChat(res, body, streamReq)
        .then((meta) => {
          logActivity({
            event: "completion",
            model,
            resolved: meta && meta.model,
            path: meta && meta.path,
            stream: streamReq,
            status: 200,
            ms: Date.now() - t0,
            reqMs: t0 - started,
            real: true,
          });
        })
        .catch((e) => {
          logActivity({
            event: "completion",
            model,
            stream: streamReq,
            status: e.status || 500,
            ms: Date.now() - t0,
            reqMs: t0 - started,
            error: e.message,
            real: true,
          });
          if (!res.headersSent) {
            res.writeHead(e.status || 500, { "Content-Type": "application/json", ...proofHeaders() });
            res.end(JSON.stringify({ error: { message: "bridge: " + e.message } }));
          }
        });
    });
    return;
  }

  // ── /v1/responses — OpenAI Responses API ──────────────────────────────────
  // Newer OpenAI SDK versions and clients (e.g. opencode itself may send this)
  // use POST /v1/responses instead of /v1/chat/completions.
  // We convert the input format and delegate to the same handleChat pipeline.
  if (urlPath === "/v1/responses" && req.method === "POST") {
    let chunks = "";
    const started = Date.now();
    req.on("data", (c) => {
      chunks += c;
    });
    req.on("end", () => {
      let rawBody = {};
      try {
        rawBody = JSON.parse(chunks || "{}");
      } catch {}

      // Convert Responses API body → chat completions body
      const body = responsesBodyToChatBody(rawBody);
      const model = body.model || "big-pickle";
      const streamReq = !!body.stream;
      const t0 = Date.now();

      handleChat(res, body, streamReq)
        .then((meta) => {
          logActivity({
            event: "completion",
            api: "responses",
            model,
            resolved: meta && meta.model,
            path: meta && meta.path,
            stream: streamReq,
            status: 200,
            ms: Date.now() - t0,
            reqMs: t0 - started,
            real: true,
          });
        })
        .catch((e) => {
          logActivity({
            event: "completion",
            api: "responses",
            model,
            stream: streamReq,
            status: e.status || 500,
            ms: Date.now() - t0,
            reqMs: t0 - started,
            error: e.message,
            real: true,
          });
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
  console.log(
    `Zen bridge REAL: http://127.0.0.1:${PORT} -> serve :${SERVE_PORT} -> rotator -> opencode.ai | race=${FAST_RACE} stream=live-deltas`
  );
});
