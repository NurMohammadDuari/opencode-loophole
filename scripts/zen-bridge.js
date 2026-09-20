/**
 * Zen Bridge — OpenAI-compatible front door on :1343
 *
 * Optimizations for speed:
 *  - HTTP keep-alive to local serve (no new TCP per hop)
 *  - Session create is cheap (~20ms); delete sessions async after use
 *  - Known-good FAST zen models preferred; broken free models remap
 *  - G4F fallback remaps zen model ids -> fast Gemini flash-lite
 *  - Optional FAST_RACE: race zen + g4f, return first 200
 *  - Real activity logging with path (zen|g4f|race)
 */
const http = require("http");
const https = require("https");
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
const FAST_RACE = process.env.FAST_RACE !== "0"; // default ON
const ZEN_TIMEOUT_MS = Number(process.env.ZEN_TIMEOUT_MS || 45000);
const G4F_TIMEOUT_MS = Number(process.env.G4F_TIMEOUT_MS || 30000);
const ACTIVITY_LOG =
  process.env.BRIDGE_ACTIVITY_LOG ||
  path.join(os.homedir(), ".local", "share", "opencode", "bridge-activity.jsonl");

const AUTH = "Basic " + Buffer.from(`${SERVE_USER}:${SERVE_PASS}`).toString("base64");

const serveAgent = new http.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 30_000 });
const g4fAgent = new http.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30_000 });

/** Models verified working + relatively fast on zen today */
const FAST_ZEN = new Set([
  "big-pickle",
  "nemotron-3.5-lightning-free",
]);

/** Prefer these when client asks for a generic "fast" / broken flash free model */
const MODEL_ALIASES = {
  "mimo-v2-flash-free": "big-pickle",
  "ling-3.0-tiny-free": "big-pickle",
  "ling-3.0-flash-free": "big-pickle",
  "ling-2.6-flash-free": "big-pickle",
  "ling-3.0-flash-fin-free": "big-pickle",
  "deepseek-v4-flash-free": "big-pickle",
  "north-mini-code-free": "big-pickle",
  "x-preview-f-free": "big-pickle",
  "longcat-2.0-free": "big-pickle",
  "glm-4.7-free": "big-pickle",
  "fast": "big-pickle",
  "fastest": "big-pickle",
  "speed": "big-pickle",
};

const WHITELIST = [
  "big-pickle",
  "nemotron-3.5-lightning-free",
  "nemotron-3-ultra-free",
  "hy3-preview-free",
  "muse-spark-1.3-contributor-free",
  "north-mini-code-free",
  "minimax-m2.1-free",
  "longcat-2.0-free",
  "deepseek-v4-flash-free",
  "laguna-s-2.1-free",
  "minimax-m3-free",
  "jev-1.13-free",
  "muse-spark-1.2-contributor-free",
  "x-preview-f-free",
  "ling-2.6-flash-free",
  "hy3-free",
  "kimi-k2.5-free",
  "ring-2.6-1t-free",
  "mimo-v2.5-free",
  "nemotron-3-super-free",
  "ling-3.0-flash-fin-free",
  "ling-3.0-flash-free",
  "trinity-large-preview-free",
  "glm-4.7-free",
  "glm-5-free",
  "mimo-v2-flash-free",
  "minimax-m2.5-free",
  "mimo-v2-omni-free",
  "mimo-v2-pro-free",
  "qwen3.6-plus-free",
  "ling-3.0-tiny-free",
];

function logActivity(entry) {
  try {
    fs.appendFileSync(ACTIVITY_LOG, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
  } catch {}
}

function modelName(m) {
  if (typeof m !== "string") return "big-pickle";
  return m.split("/").pop().replace(/^opencode:/, "");
}

function resolveZenModel(m) {
  const raw = modelName(m);
  return MODEL_ALIASES[raw] || raw;
}

function messageText(m) {
  if (m == null) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((p) => (typeof p === "string" ? p : p && (p.text || p.content) || ""))
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
            resolve({ status: res.statusCode, json: JSON.parse(out), raw: out });
          } catch {
            resolve({ status: res.statusCode, json: { raw: out }, raw: out });
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout " + timeoutMs + "ms"));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function callServe(method, reqPath, body) {
  return httpJson(serveAgent, SERVE_HOST, SERVE_PORT, method, reqPath, body, ZEN_TIMEOUT_MS, {
    authorization: AUTH,
  });
}

function callG4f(body, timeoutMs = G4F_TIMEOUT_MS) {
  // Force a known-fast g4f model + Gemini provider when possible
  const payload = {
    ...body,
    model: G4F_FAST_MODEL,
    provider: "Gemini",
    stream: false,
  };
  return httpJson(g4fAgent, G4F_HOST, G4F_PORT, "POST", "/v1/chat/completions", payload, timeoutMs);
}

function extractText(message) {
  const parts = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.type === "text" && typeof node.text === "string") parts.push(node.text);
    if (node.parts) walk(node.parts);
  };
  walk(message);
  return parts.join("");
}

function buildOpenAiResponse(message, model, reqId) {
  const text = extractText(message);
  return {
    id: "chatcmpl-" + (message.info && message.info.id ? message.info.id : crypto.randomBytes(8).toString("hex")),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage:
      message.info && message.info.tokens
        ? {
            prompt_tokens: message.info.tokens.prompt,
            completion_tokens: message.info.tokens.completion,
            total_tokens: message.info.tokens.total,
          }
        : undefined,
    system_fingerprint: reqId,
  };
}

function writeOpenAi(res, openaiRes, stream) {
  if (!stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(openaiRes));
  }
  const text = openaiRes.choices[0].message.content || "";
  const model = openaiRes.model;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  if (text) {
    res.write(
      `data: ${JSON.stringify({
        id: openaiRes.id,
        object: "chat.completion.chunk",
        created: openaiRes.created,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      })}\n\n`
    );
  }
  res.write(
    `data: ${JSON.stringify({
      id: openaiRes.id,
      object: "chat.completion.chunk",
      created: openaiRes.created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`
  );
  res.write("data: [DONE]\n\n");
  return res.end();
}

async function zenOnce(model, body) {
  const session = await callServe("POST", "/session", { directory: null });
  if (session.status !== 200 || !session.json || !session.json.id) {
    const err = new Error("serve session failed: " + session.status);
    err.status = session.status;
    throw err;
  }
  const sessionID = session.json.id;
  try {
    const textParts = (body.messages || []).map((m) => ({
      type: "text",
      text: messageText(m),
      id: "prt_" + crypto.randomBytes(12).toString("hex"),
    }));
    const payload = {
      model: { providerID: "opencode", modelID: model },
      parts: textParts,
    };
    const msg = await callServe("POST", `/session/${sessionID}/message`, payload);
    if (msg.status !== 200) {
      const err = new Error("serve message failed: " + msg.status + " " + (msg.raw || "").slice(0, 200));
      err.status = msg.status;
      throw err;
    }
    if (msg.json && msg.json.name === "UnknownError") {
      const err = new Error("serve UnknownError: " + ((msg.json.data && msg.json.data.message) || ""));
      err.status = 500;
      throw err;
    }
    if (msg.json && msg.json.info && msg.json.info.error) {
      const err = new Error("serve model error: " + JSON.stringify(msg.json.info.error).slice(0, 240));
      err.status = 502;
      throw err;
    }
    return { openaiRes: buildOpenAiResponse(msg.json, model, sessionID), sessionID, path: "zen" };
  } finally {
    // fire-and-forget cleanup — don't block the response
    callServe("DELETE", `/session/${sessionID}`).catch(() => {});
  }
}

async function g4fOnce(body) {
  const g4fRes = await callG4f(body);
  if (g4fRes.status !== 200 || !g4fRes.json || !g4fRes.json.choices) {
    const err = new Error("g4f failed: " + g4fRes.status + " " + (g4fRes.raw || "").slice(0, 200));
    err.status = g4fRes.status || 502;
    throw err;
  }
  // Normalize model field to what client asked
  const out = { ...g4fRes.json, model: g4fRes.json.model || G4F_FAST_MODEL };
  return { openaiRes: out, sessionID: "g4f", path: "g4f" };
}

function raceFirst(promises) {
  return new Promise((resolve, reject) => {
    let pending = promises.length;
    let lastErr = null;
    let settled = false;
    for (const p of promises) {
      Promise.resolve(p).then(
        (v) => {
          if (!settled) {
            settled = true;
            resolve(v);
          }
        },
        (e) => {
          lastErr = e;
          pending -= 1;
          if (pending === 0 && !settled) reject(lastErr || new Error("all raced paths failed"));
        }
      );
    }
  });
}

async function handleChat(res, body, stream) {
  const requested = modelName(body.model);
  const zenModel = resolveZenModel(requested);
  const preferRace = FAST_RACE && (FAST_ZEN.has(zenModel) || MODEL_ALIASES[requested] || requested === zenModel);

  let result;
  if (preferRace) {
    // Race zen (fast model) vs g4f flash-lite — first 200 wins
    result = await raceFirst([
      zenOnce(zenModel, body).then((r) => ({ ...r, path: "race-zen" })),
      g4fOnce(body).then((r) => ({ ...r, path: "race-g4f" })),
    ]);
  } else {
    try {
      result = await zenOnce(zenModel, body);
    } catch (e) {
      console.error("Zen Bridge: zen failed, g4f fallback:", e.message);
      result = await g4fOnce(body);
    }
  }

  writeOpenAi(res, result.openaiRes, stream);
  return { path: result.path, model: zenModel, requested };
}

const server = http.createServer((req, res) => {
  res.on("error", () => {});
  const urlPath = (req.url || "/").split("?")[0];

  if ((urlPath === "/v1/models" || urlPath === "/models") && req.method === "GET") {
    const models = WHITELIST.map((id) => ({
      id: "opencode/" + id,
      object: "model",
      created: 0,
      owned_by: "opencode",
    }));
    // Advertise fast aliases
    models.unshift(
      { id: "opencode/fast", object: "model", created: 0, owned_by: "opencode" },
      { id: "opencode/fastest", object: "model", created: 0, owned_by: "opencode" }
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: models }));
  }

  if (urlPath === "/health" || urlPath === "/v1/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        ok: true,
        service: "bridge",
        uptime: process.uptime(),
        fastRace: FAST_RACE,
        g4fFastModel: G4F_FAST_MODEL,
        defaultZen: "big-pickle",
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
          });
          if (!res.headersSent) res.writeHead(e.status || 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "bridge: " + e.message } }));
        });
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "bridge: unknown path " + urlPath } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `Zen bridge: http://127.0.0.1:${PORT} -> serve :${SERVE_PORT} | FAST_RACE=${FAST_RACE} g4f=${G4F_FAST_MODEL}`
  );
  console.log("Fast zen models: " + [...FAST_ZEN].join(", "));
});
