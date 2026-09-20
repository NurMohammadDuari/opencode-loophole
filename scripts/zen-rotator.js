/**
 * Zen Rotator — REAL reverse proxy to opencode.ai/zen/v1
 * Rotates X-Real-IP; keep-alive TLS; writes proof log of every upstream hop.
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dns = require("dns");

const UPSTREAM_HOST = "opencode.ai";
const UPSTREAM_PATH = "/zen/v1";
const PORT = process.env.ZEN_ROTATOR_PORT ? Number(process.env.ZEN_ROTATOR_PORT) : 1341;
const PROOF_FILE =
  process.env.ROTATOR_PROOF_FILE ||
  path.join(os.homedir(), ".local", "share", "opencode", "rotator-proof.jsonl");

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

function logProof(entry) {
  try {
    fs.appendFileSync(PROOF_FILE, JSON.stringify({ ts: Date.now(), real: true, upstream: UPSTREAM_HOST, ...entry }) + "\n");
  } catch {}
}

dns.lookup(UPSTREAM_HOST, { all: true }, (err, addrs) => {
  if (err) console.log("[Rotator] DNS lookup failed:", err.message);
  else console.log("[Rotator] opencode.ai resolves to:", addrs.map((a) => a.address).join(", "));
});

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
      let n = 0;
      res.on("data", (c) => {
        n += c.length;
      });
      res.on("end", () => {
        console.log("[Rotator] TLS warm REAL status=" + res.statusCode + " bytes=" + n);
        logProof({ event: "warm", status: res.statusCode, bytes: n, path: "/models" });
      });
    }
  );
  req.on("error", (e) => console.log("[Rotator] TLS warm skip: " + e.message));
  req.end();
})();

const server = http.createServer((req, res) => {
  res.on("error", () => {});
  const t0 = Date.now();
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

    const xRealIp = randIp();
    headers["host"] = UPSTREAM_HOST;
    headers["x-real-ip"] = xRealIp;
    headers["user-agent"] = headers["user-agent"] || `opencode/${process.env.ZEN_UA_VERSION || "1.18.31"}`;
    if (chunks) headers["content-length"] = Buffer.byteLength(chunks).toString();
    else delete headers["content-length"];

    const upstreamPath = UPSTREAM_PATH + req.url;
    const proxyRes = https.request(
      {
        agent: upstreamAgent,
        hostname: UPSTREAM_HOST,
        port: 443,
        path: upstreamPath,
        method: req.method,
        headers,
        timeout: 60000,
      },
      (upstream) => {
        const resHeaders = { ...upstream.headers };
        delete resHeaders["connection"];
        delete resHeaders["transfer-encoding"];
        resHeaders["x-loophole-real"] = "1";
        resHeaders["x-loophole-upstream"] = UPSTREAM_HOST;
        resHeaders["x-loophole-x-real-ip"] = xRealIp;
        res.writeHead(upstream.statusCode, resHeaders);

        let bytes = 0;
        upstream.on("data", (c) => {
          bytes += c.length;
        });
        upstream.on("end", () => {
          logProof({
            event: "proxy",
            method: req.method,
            path: req.url,
            status: upstream.statusCode,
            ms: Date.now() - t0,
            bytes,
            xRealIp,
            upstreamPath,
          });
        });
        upstream.pipe(res, { end: true });
      }
    );
    proxyRes.on("timeout", () => {
      proxyRes.destroy(new Error("upstream timeout"));
    });
    proxyRes.on("error", (e) => {
      console.error(`[Rotator] Upstream REAL error: ${e.message}`);
      logProof({ event: "error", method: req.method, path: req.url, error: e.message, xRealIp, ms: Date.now() - t0 });
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json", "x-loophole-real": "1" });
      res.end(JSON.stringify({ error: { message: "zen-rotator: " + e.message } }));
    });
    if (chunks) proxyRes.write(chunks);
    proxyRes.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    "Zen rotator REAL: http://127.0.0.1:" + PORT + " -> https://" + UPSTREAM_HOST + "/zen/v1 (keepAlive + X-Real-IP)"
  );
});
