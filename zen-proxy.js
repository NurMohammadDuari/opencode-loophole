const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");

const UPSTREAM_HOST = "opencode.ai";
const UPSTREAM = "https://opencode.ai";
const PORT = process.env.ZEN_PROXY_PORT ? Number(process.env.ZEN_PROXY_PORT) : 1338;
const MIN_MS = process.env.ZEN_PROXY_INTERVAL ? Number(process.env.ZEN_PROXY_INTERVAL) : 4000;
const TOKEN_FILE = process.env.ZEN_TOKEN_FILE || path.join(os.homedir(), ".config", "opencode", "zen-tokens.txt");

const uas = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
];

function loadTokens() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, "utf8");
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

let tokens = loadTokens();
let tokenIdx = 0;
fs.watch(TOKEN_FILE, () => { tokens = loadTokens(); });
setInterval(() => { tokens = loadTokens(); }, 30000);

const lastReq = new Map();

function getModel(body) {
  try {
    return JSON.parse(body).model || "unknown";
  } catch {
    return "unknown";
  }
}

function nextAuth() {
  if (tokens.length === 0) return null;
  const t = tokens[tokenIdx % tokens.length];
  tokenIdx += 1;
  return t;
}

function attempts() {
  return tokens.length > 0 ? tokens.length + 1 : 1;
}

function forward(req, res, path, body, auth) {
  // Strip leading '/v1' if present to avoid double /v1 in upstream URL
  if (path.startsWith('/v1')) {
    path = path.slice(3);
  }
  // Ensure model name has correct prefix
  let modifiedBody = body;
  if (body) {
    try {
      const obj = JSON.parse(body);
      if (obj.model && typeof obj.model === 'string' && !obj.model.startsWith('opencode/')) {
        obj.model = 'opencode/' + obj.model;
        modifiedBody = JSON.stringify(obj);
      }
    } catch (e) {
      // If parsing fails, leave body unchanged
    }
  }
  const headers = { ...req.headers, host: UPSTREAM_HOST };
  headers["authorization"] = auth ? "Bearer " + auth : (headers["authorization"] || "Bearer ");
  if (process.env.ZEN_UA_SPOOF === "1") headers["user-agent"] = uas[Math.floor(Math.random() * uas.length)];
  headers["content-length"] = Buffer.byteLength(modifiedBody || "").toString();

  const options = {
    hostname: UPSTREAM_HOST,
    port: 443,
    path: "/zen/v1" + path,
    method: req.method,
    headers,
  };

  const proxyRes = https.request(options, (upstream) => {
    res.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(res, { end: true });
  });
  proxyRes.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "zen-proxy: " + e.message } }));
  });
  if (modifiedBody) proxyRes.write(modifiedBody);
  proxyRes.end();
}


const server = http.createServer((req, res) => {
  res.on("error", () => {});
  let chunks = "";
  req.on("data", (c) => { chunks += c; });
  req.on("end", () => {
    const model = getModel(chunks);
    const now = Date.now();
    const wait = Math.max(0, MIN_MS - (now - (lastReq.get(model) || 0)));
    lastReq.set(model, now + wait);
    const doForward = () => forward(req, res, req.url, chunks, nextAuth());
    if (wait > 0) setTimeout(doForward, wait);
    else doForward();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Zen proxy: http://127.0.0.1:" + PORT + " -> " + UPSTREAM + "/zen/v1, " + MIN_MS + "ms/model, tokens=" + tokens.length);
});