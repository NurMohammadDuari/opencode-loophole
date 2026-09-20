const http = require("http");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.DASHBOARD_PORT || 1395);
const HOME = os.homedir();
const DB_PATH = process.env.OPENCODE_DB || path.join(HOME, ".local", "share", "opencode", "opencode.db");
const ACTIVITY_LOG = process.env.BRIDGE_ACTIVITY_LOG || path.join(HOME, ".local", "share", "opencode", "bridge-activity.jsonl");

const SERVICES = [
  { name: "bridge", label: "Zen Bridge", port: 1343, unit: "zen-bridge.service", healthUrl: "http://127.0.0.1:1343/health",
    desc: "OpenAI /v1/chat/completions -> local serve session API" },
  { name: "serve", label: "OpenCode Serve", port: 18765, unit: "opencode-serve.service", healthUrl: "",
    desc: "Real OpenCode client session (passes the zen Console gate)" },
  { name: "rotator", label: "Zen Rotator", port: 1341, unit: "zen-rotator.service", healthUrl: "",
    desc: "Rotates x-real-ip per request = fresh per-IP daily bucket = unlimited" },
  { name: "g4f", label: "g4f Mirror Pool", port: 1337, unit: "g4f-api.service", healthUrl: "http://127.0.0.1:1337/v1/models",
    desc: "Free LLM mirror pool (localhost:1337)" },
];

function probePort(port, timeout = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
    sock.setTimeout(timeout, () => { sock.destroy(); resolve(false); });
  });
}

function httpGet(url, timeout = 1200) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? require("https") : require("http");
    const t0 = Date.now();
    const req = mod.get(url, { timeout }, (res) => {
      let out = "";
      res.on("data", (c) => { out += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(out); } catch {}
        resolve({ status: res.statusCode, ms: Date.now() - t0, json });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, ms: Date.now() - t0, error: "timeout" }); });
    req.on("error", (e) => resolve({ status: 0, ms: Date.now() - t0, error: e.message }));
  });
}

function unitState(unit) {
  try {
    const r = spawnSync("systemctl", ["--user", "show", unit, "--property=ActiveState,SubState,MainPID"], { encoding: "utf8", timeout: 4000 });
    if (r.status !== 0) return { active: false, state: "missing", pid: 0 };
    const props = {};
    (r.stdout || "").split("\n").forEach((l) => {
      const idx = l.indexOf("=");
      if (idx > -1) props[l.slice(0, idx)] = l.slice(idx + 1);
    });
    const active = props["ActiveState"] === "active";
    const state = props["SubState"] || props["ActiveState"] || "unknown";
    const pid = Number(props["MainPID"] || 0);
    return { active, state, pid };
  } catch {
    return { active: false, state: "unknown", pid: 0 };
  }
}

function sysctl(unit, action) {
  const r = spawnSync("systemctl", ["--user", action, unit], { encoding: "utf8", timeout: 15000 });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function unitLogs(unit, n = 200) {
  try {
    const r = spawnSync("journalctl", ["--user", "-u", unit, "-n", String(n), "--no-pager", "-o", "cat"], { encoding: "utf8", timeout: 5000 });
    if (r.status !== 0) return (r.stderr || "").trim() || "no logs";
    return (r.stdout || "").trim() || "(no output)";
  } catch (e) {
    return e.message;
  }
}

function readActivity(limit = 300) {
  try {
    if (!fs.existsSync(ACTIVITY_LOG)) return [];
    const raw = fs.readFileSync(ACTIVITY_LOG, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-limit);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

function aggregateActivity() {
  const entries = readActivity(500);
  const now = Date.now();
  const total = entries.length;
  let ok = 0, fail = 0, msSum = 0;
  const byModel = {};
  const perMin = {};
  entries.forEach((e) => {
    if (e.status === 200) ok++; else fail++;
    if (e.ms != null) msSum += e.ms;
    byModel[e.model || "unknown"] = (byModel[e.model || "unknown"] || 0) + 1;
    const min = Math.floor((e.ts || 0) / 60000) * 60000;
    perMin[min] = (perMin[min] || 0) + 1;
  });
  const lastMin = entries.filter((e) => e.ts && now - e.ts < 60000).length;
  return { total, ok, fail, avgMs: entries.length ? Math.round(msSum / entries.length) : 0, lastMin, byModel, perMin };
}

let db = null;
function getDb() {
  if (db) {
    try { db.exec("SELECT 1"); } catch { db = null; }
  }
  if (!db && fs.existsSync(DB_PATH)) {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  }
  return db;
}

function listSessions(limit = 20) {
  try {
    const d = getDb();
    if (!d) return [];
    const rows = d.prepare(
      `SELECT id, slug, title, model, agent, directory, time_created, time_updated, tokens_input, tokens_output, cost
       FROM session
       WHERE time_archived IS NULL
       ORDER BY time_updated DESC
       LIMIT ?`
    ).all(limit);
    return rows.map((r) => {
      let model = null;
      try { model = r.model ? JSON.parse(r.model).id || r.model : null; } catch { model = r.model; }
      return {
        id: r.id, slug: r.slug, title: r.title || r.slug, model, agent: r.agent, directory: r.directory,
        created: r.time_created, updated: r.time_updated,
        tokensIn: r.tokens_input || 0, tokensOut: r.tokens_output || 0, cost: r.cost || 0,
      };
    });
  } catch (e) {
    return { error: e.message };
  }
}

function sessionMessages(id, limit = 100) {
  try {
    const d = getDb();
    if (!d) return [];
    const parts = d.prepare(
      `SELECT id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC LIMIT ?`
    ).all(id, limit);
    const out = [];
    for (const p of parts) {
      let pj = null;
      try { pj = JSON.parse(p.data); } catch {}
      if (!pj) continue;
      const type = pj.type || "part";
      let text = null;
      if (type === "text" && typeof pj.text === "string") text = pj.text;
      else if (type === "tool") text = "[Tool: " + (pj.tool || "?") + "]";
      else if (type === "tool-invocation") text = "[Invoking: " + (pj.toolName || "?") + "]";
      else if (type === "tool-result") text = "[Tool Result: " + JSON.stringify(pj.result || "").slice(0, 300) + "]";
      if (text) {
        out.push({ role: type, time: p.time_created, text });
      }
    }
    return out;
  } catch (e) {
    return { error: e.message };
  }
}

function systemInfo() {
  const total = os.totalmem(), free = os.freemem();
  return {
    hostname: os.hostname(),
    platform: os.platform() + " " + os.release(),
    uptimeSec: os.uptime(),
    load: os.loadavg(),
    memUsedPct: Math.round(((total - free) / total) * 100),
    memTotal: total,
    node: process.version,
    now: Date.now(),
  };
}

async function status() {
  const services = [];
  for (const s of SERVICES) {
    const [listen, st] = await Promise.all([probePort(s.port), Promise.resolve(unitState(s.unit))]);
    const svc = { name: s.name, label: s.label, port: s.port, unit: s.unit, desc: s.desc, listen, systemd: st };
    if (s.healthUrl && listen) {
      const h = await httpGet(s.healthUrl);
      svc.health = { status: h.status, ms: h.ms, uptime: (h.json && h.json.uptime) || undefined };
    }
    services.push(svc);
  }
  return { ts: Date.now(), services };
}

function testBridgeChain(model = "big-pickle") {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const data = JSON.stringify({
      model: model.startsWith("opencode/") ? model : "opencode/" + model,
      messages: [{ role: "user", content: "Reply with OK" }],
      stream: false,
    });
    const req = http.request({
      hostname: "127.0.0.1",
      port: 1343,
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: 30000,
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(body); } catch {}
        const content = json && json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message.content : (body || "");
        resolve({ ok: res.statusCode === 200, status: res.statusCode, ms: Date.now() - t0, model, reply: content });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 408, ms: Date.now() - t0, model, reply: "timeout (30s)" }); });
    req.on("error", (e) => resolve({ ok: false, status: 500, ms: Date.now() - t0, model, reply: e.message }));
    req.write(data);
    req.end();
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function sendText(res, code, text, type) {
  res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  res.on("error", () => {});
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;

  try {
    // Serve static UI files — look next to this file first, then one level up
    const PUBLIC_ROOT = fs.existsSync(path.join(__dirname, "public"))
      ? path.join(__dirname, "public")
      : path.resolve(__dirname, "..", "public");
    if (p === "/" || p === "/index.html") {
      const htmlPath = path.join(PUBLIC_ROOT, "index.html");
      const html = fs.readFileSync(htmlPath, "utf8");
      return sendText(res, 200, html, "text/html; charset=utf-8");
    }
    // Serve other static assets (CSS, JS, images) from PUBLIC_ROOT
    const cleanPath = p.startsWith('/') ? p.slice(1) : p;
    const staticPath = path.join(PUBLIC_ROOT, cleanPath);
    if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      const ext = path.extname(staticPath).toLowerCase();
      const mimeMap = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css",
        ".js": "application/javascript",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".gif": "image/gif"
      };
      const mime = mimeMap[ext] || "application/octet-stream";
      const data = fs.readFileSync(staticPath);
      return sendText(res, 200, data, mime);
    }
    if (p === "/api/status" && req.method === "GET") return sendJson(res, 200, await status());
    if (p === "/api/system" && req.method === "GET") return sendJson(res, 200, systemInfo());
    if (p === "/api/activity" && req.method === "GET") return sendJson(res, 200, { ok: true, entries: readActivity(300), agg: aggregateActivity() });
    if (p === "/api/sessions" && req.method === "GET") return sendJson(res, 200, { ok: true, sessions: listSessions(Number(u.searchParams.get("limit")) || 20) });
    if (p.startsWith("/api/session/") && req.method === "GET") {
      const id = p.slice("/api/session/".length);
      if (id) return sendJson(res, 200, { ok: true, id, messages: sessionMessages(id) });
    }
    if (p.startsWith("/api/logs/") && req.method === "GET") {
      const unit = p.slice("/api/logs/".length);
      return sendText(res, 200, unitLogs(unit));
    }
    if (p.startsWith("/api/service/") && req.method === "POST") {
      const rest = p.slice("/api/service/".length);
      const idx = rest.lastIndexOf("/");
      const unit = rest.slice(0, idx);
      const action = rest.slice(idx + 1);
      if (!["start", "stop", "restart"].includes(action)) return sendJson(res, 400, { ok: false, error: "bad action" });
      const r = sysctl(unit, action);
      return sendJson(res, r.ok ? 200 : 500, { ok: r.ok, action, unit, out: r.out, err: r.err });
    }
    if (p === "/api/restart-all" && req.method === "POST") {
      const r1 = sysctl("zen-rotator.service", "restart");
      const r2 = sysctl("opencode-serve.service", "restart");
      const r3 = sysctl("zen-bridge.service", "restart");
      const r4 = sysctl("g4f-api.service", "restart");
      return sendJson(res, 200, { ok: r1.ok && r2.ok && r3.ok && r4.ok, msg: "All loophole services restarted" });
    }
    if (p === "/api/test-chain" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", async () => {
        let model = "big-pickle";
        try { const j = JSON.parse(body || "{}"); if (j.model) model = j.model; } catch {}
        const result = await testBridgeChain(model);
        return sendJson(res, 200, result);
      });
      return;
    }
    if (p === "/api/proof" && req.method === "GET") {
      const share = path.join(os.homedir(), ".local", "share", "opencode");
      const proofPath = process.env.BRIDGE_PROOF_FILE || path.join(share, "loophole-proof.json");
      const rotPath = process.env.ROTATOR_PROOF_FILE || path.join(share, "rotator-proof.jsonl");
      let proof = {}, rotatorProofs = [];
      try { proof = JSON.parse(fs.readFileSync(proofPath, "utf8")); } catch {}
      try {
        if (fs.existsSync(rotPath)) {
          const lines = fs.readFileSync(rotPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-20);
          rotatorProofs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        }
      } catch {}
      return sendJson(res, 200, { ok: true, proof, rotatorProofs });
    }
    if (p === "/api/stream" && req.method === "GET") {
      const share = path.join(os.homedir(), ".local", "share", "opencode");
      const actPath = process.env.BRIDGE_ACTIVITY_LOG || path.join(share, "bridge-activity.jsonl");
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      let closed = false;
      const interval = setInterval(() => {
        if (closed) { clearInterval(interval); return; }
        try {
          if (!fs.existsSync(actPath)) { res.write("data: {}\n\n"); return; }
          const raw = fs.readFileSync(actPath, "utf8");
          const lines = raw.split(/\r?\n/).filter(Boolean).slice(-5);
          const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          res.write("data: " + JSON.stringify({ entries, ts: Date.now() }) + "\n\n");
        } catch { res.write("data: {}\n\n"); }
      }, 2000);
      req.on("close", () => { closed = true; clearInterval(interval); });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("OpenCode Loophole Dashboard listening on http://127.0.0.1:" + PORT);
});



