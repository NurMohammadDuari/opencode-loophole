const http = require("http");
const https = require("https");
const crypto = require("crypto");

const SERVE_HOST = "127.0.0.1";
const SERVE_PORT = Number(process.env.SERVE_PORT || 18765);
const SERVE_USER = process.env.SERVE_USER || "opencode";
const SERVE_PASS = process.env.SERVE_PASS || "opencodepass";
const PORT = process.env.BRIDGE_PORT ? Number(process.env.BRIDGE_PORT) : 1338;

const WHITELIST = [
  "big-pickle",
  "nemotron-3-ultra-free", "hy3-preview-free", "muse-spark-1.3-contributor-free",
  "north-mini-code-free", "minimax-m2.1-free", "longcat-2.0-free",
  "deepseek-v4-flash-free", "laguna-s-2.1-free", "minimax-m3-free", "jev-1.13-free",
  "muse-spark-1.2-contributor-free", "x-preview-f-free", "ling-2.6-flash-free",
  "nemotron-3.5-lightning-free", "hy3-free", "kimi-k2.5-free", "ring-2.6-1t-free",
  "mimo-v2.5-free", "nemotron-3-super-free", "ling-3.0-flash-fin-free",
  "ling-3.0-flash-free", "trinity-large-preview-free", "glm-4.7-free", "glm-5-free",
  "mimo-v2-flash-free", "minimax-m2.5-free", "mimo-v2-omni-free", "mimo-v2-pro-free",
  "qwen3.6-plus-free", "ling-3.0-tiny-free",
];

const AUTH = "Basic " + Buffer.from(`${SERVE_USER}:${SERVE_PASS}`).toString("base64");

function modelName(m) {
  if (typeof m !== "string") return "big-pickle";
  return m.split("/").pop().replace(/^opencode:/, "");
}

function callServe(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: SERVE_HOST,
      port: SERVE_PORT,
      path,
      method,
      headers: {
        "content-type": "application/json",
        authorization: AUTH,
        ...(data ? { "content-length": Buffer.byteLength(data) } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let out = "";
      res.on("data", (c) => { out += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(out) }); }
        catch { resolve({ status: res.statusCode, json: { raw: out } }); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function extractText(message) {
  const parts = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
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
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: message.info && message.info.error ? "stop" : "stop",
    }],
    usage: message.info && message.info.tokens
      ? { prompt_tokens: message.info.tokens.prompt, completion_tokens: message.info.tokens.completion, total_tokens: message.info.tokens.total }
      : undefined,
    system_fingerprint: reqId,
  };
}

async function handleChat(res, body, stream) {
  const model = modelName(body.model);
  const session = await callServe("POST", "/session", { directory: null });
  if (session.status !== 200) {
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "serve session: " + (session.json.raw || session.json.message || session.status) } }));
  }
  const sessionID = session.json.id;

  const textParts = (body.messages || []).map((m) => ({
    type: "text",
    text: (m.content || "").toString(),
    id: "prt_" + crypto.randomBytes(12).toString("hex"),
  }));
  const payload = {
    model: { providerID: "opencode", modelID: model },
    parts: textParts,
  };

  const msg = await callServe("POST", `/session/${sessionID}/message`, payload);
  if (msg.status !== 200) {
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "serve message: " + (msg.json.raw || msg.json.message || msg.status), error: msg.json } }));
  }

  const openaiRes = buildOpenAiResponse(msg.json, model, sessionID);

  if (!stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(openaiRes));
  }

  // Emit as a single SSE chunk then [DONE]; satisfies OpenAI stream clients.
  const text = openaiRes.choices[0].message.content;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  if (text) {
    res.write(`data: ${JSON.stringify({ id: openaiRes.id, object: "chat.completion.chunk", created: openaiRes.created, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ id: openaiRes.id, object: "chat.completion.chunk", created: openaiRes.created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  res.on("error", () => {});
  const urlPath = req.url.split("?")[0];

  if ((urlPath === "/v1/models" || urlPath === "/models") && req.method === "GET") {
    const models = WHITELIST.map((id) => ({ id: "opencode/" + id, object: "model", created: 0, owned_by: "opencode" }));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: models }));
  }

  if ((urlPath === "/v1/chat/completions" || urlPath === "/chat/completions" || urlPath === "/v1/messages") && req.method === "POST") {
    let chunks = "";
    req.on("data", (c) => { chunks += c; });
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(chunks || "{}"); } catch {}
      handleChat(res, body, !!body.stream).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bridge: " + e.message } }));
      });
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "bridge: unknown path " + urlPath } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Zen bridge: http://127.0.0.1:" + PORT + " (OpenAI-compat) -> serve :" + SERVE_PORT + " session API");
  console.log("Models: " + WHITELIST.length + ", sample: " + WHITELIST.slice(0, 3).join(", "));
});