const http = require("http");
const https = require("https");
const crypto = require("crypto");

const UPSTREAM_HOST = "opencode.ai";
const UPSTREAM_PATH = "/zen/v1";
const PORT = process.env.ZEN_ROTATOR_PORT ? Number(process.env.ZEN_ROTATOR_PORT) : 1341;

function randIp() {
  const b = () => 1 + Math.floor(Math.random() * 254);
  return `${b()}.${b()}.${b()}.${b()}`;
}

const server = http.createServer((req, res) => {
  res.on("error", () => {});
  let chunks = "";
  req.on("data", (c) => { chunks += c; });
  req.on("end", () => {
    const headers = { ...req.headers };
    delete headers["host"];
    delete headers["connection"];
    delete headers["keep-alive"];
    delete headers["proxy-authenticate"];
    delete headers["proxy-authorization"];
    delete headers["te"];
    delete headers["trailers"];
    delete headers["transfer-encoding"];
    delete headers["upgrade"];

    headers["host"] = UPSTREAM_HOST;
    headers["x-real-ip"] = randIp();
    headers["user-agent"] = headers["user-agent"] || `opencode/${process.env.ZEN_UA_VERSION || "1.18.31"}`;
    if (chunks) {
      headers["content-length"] = Buffer.byteLength(chunks).toString();
    } else {
      delete headers["content-length"];
    }

    const options = {
      hostname: UPSTREAM_HOST,
      port: 443,
      path: UPSTREAM_PATH + req.url,
      method: req.method,
      headers,
      timeout: 60000,
    };

    const proxyRes = https.request(options, (upstream) => {
      // Remove upstream hop-by-hop headers
      const resHeaders = { ...upstream.headers };
      delete resHeaders["connection"];
      delete resHeaders["transfer-encoding"];
      res.writeHead(upstream.statusCode, resHeaders);
      upstream.pipe(res, { end: true });
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
  console.log("Zen rotator: http://127.0.0.1:" + PORT + " -> " + UPSTREAM_HOST + "/zen/v1, rotating x-real-ip per request");
});