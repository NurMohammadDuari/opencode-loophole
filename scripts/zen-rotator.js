/**
 * Zen Rotator — keep-alive TLS to opencode.ai/zen/v1, rotate X-Real-IP
 */
const http = require("http");
const https = require("https");

const UPSTREAM_HOST = "opencode.ai";
const UPSTREAM_PATH = "/zen/v1";
const PORT = process.env.ZEN_ROTATOR_PORT ? Number(process.env.ZEN_ROTATOR_PORT) : 1341;

const upstreamAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  keepAliveMsecs: 30_000,
  scheduling: "lifo",
});

function randIp() {
  const b = () => 1 + Math.floor(Math.random() * 254);
  return `${b()}.${b()}.${b()}.${b()}`;
}

// Warm TLS to cut first-request latency
(function warm() {
  const req = https.request(
    {
      agent: upstreamAgent,
      hostname: UPSTREAM_HOST,
      port: 443,
      path: UPSTREAM_PATH + "/models",
      method: "GET",
      headers: { host: UPSTREAM_HOST, "user-agent": `opencode/${process.env.ZEN_UA_VERSION || "1.18.31"}` },
      timeout: 8000,
    },
    (res) => {
      res.resume();
      console.log("[Rotator] TLS warm status=" + res.statusCode);
    }
  );
  req.on("error", (e) => console.log("[Rotator] TLS warm skip: " + e.message));
  req.end();
})();

const server = http.createServer((req, res) => {
  res.on("error", () => {});
  let chunks = "";
  req.on("data", (c) => {
    chunks += c;
  });
  req.on("end", () => {
    const headers = { ...req.headers };
    for (const h of [
      "host",
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailers",
      "transfer-encoding",
      "upgrade",
    ]) {
      delete headers[h];
    }

    headers["host"] = UPSTREAM_HOST;
    headers["x-real-ip"] = randIp();
    headers["user-agent"] = headers["user-agent"] || `opencode/${process.env.ZEN_UA_VERSION || "1.18.31"}`;
    if (chunks) headers["content-length"] = Buffer.byteLength(chunks).toString();
    else delete headers["content-length"];

    const proxyRes = https.request(
      {
        agent: upstreamAgent,
        hostname: UPSTREAM_HOST,
        port: 443,
        path: UPSTREAM_PATH + req.url,
        method: req.method,
        headers,
        timeout: 60000,
      },
      (upstream) => {
        const resHeaders = { ...upstream.headers };
        delete resHeaders["connection"];
        delete resHeaders["transfer-encoding"];
        res.writeHead(upstream.statusCode, resHeaders);
        upstream.pipe(res, { end: true });
      }
    );
    proxyRes.on("timeout", () => {
      proxyRes.destroy(new Error("upstream timeout"));
    });
    proxyRes.on("error", (e) => {
      console.error(`[Rotator] Upstream error: ${e.message}`);
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "zen-rotator: " + e.message } }));
    });
    if (chunks) proxyRes.write(chunks);
    proxyRes.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    "Zen rotator: http://127.0.0.1:" + PORT + " -> " + UPSTREAM_HOST + "/zen/v1 (keepAlive + X-Real-IP rotate)"
  );
});
