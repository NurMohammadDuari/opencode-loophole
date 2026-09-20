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
    if (p === "/" || p === "/index.html") return sendText(res, 200, UI, "text/html; charset=utf-8");
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

const UI = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenCode Loophole Control Center</title>
<style>
:root{
  --bg: #090d16;
  --panel: #111827;
  --panel2: #0e1422;
  --border: #1f293d;
  --border-focus: #3b82f6;
  --text: #f1f5f9;
  --dim: #94a3b8;
  --green: #10b981;
  --green-glow: rgba(16, 185, 129, 0.35);
  --red: #ef4444;
  --red-glow: rgba(239, 68, 68, 0.35);
  --amber: #f59e0b;
  --blue: #3b82f6;
  --blue-glow: rgba(59, 130, 246, 0.35);
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:13.5px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:22px;max-width:1440px;margin:0 auto}
h1{font-size:20px;font-weight:700;letter-spacing:-.2px;display:flex;align-items:center;gap:10px}
h2{font-size:12.5px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin:24px 0 10px;font-weight:600}
.top-bar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px 20px;box-shadow:0 4px 20px rgba(0,0,0,0.25)}
.badge{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:20px;font-size:11.5px;font-weight:600}
.badge.ok{background:rgba(16,185,129,0.15);color:var(--green);border:1px solid rgba(16,185,129,0.3)}
.badge.bad{background:rgba(239,68,68,0.15);color:var(--red);border:1px solid rgba(239,68,68,0.3)}
.mini{color:var(--dim);font-size:12px}
.mono{font-family:var(--mono)}
.grid{display:grid;gap:14px}
.cards{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:16px;box-shadow:0 4px 16px rgba(0,0,0,0.2)}
.card{border-radius:14px;border:1px solid var(--border);padding:14px;background:var(--panel);position:relative;display:flex;flex-direction:column;justify-content:space-between;transition:border-color .15s}
.card:hover{border-color:rgba(59,130,246,0.5)}
.card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.card h3{font-size:14.5px;font-weight:600;display:flex;align-items:center;gap:8px}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block}
.dot.ok{background:var(--green);box-shadow:0 0 10px var(--green-glow)}
.dot.bad{background:var(--red);box-shadow:0 0 10px var(--red-glow)}
.dot.hold{background:var(--amber);box-shadow:0 0 8px rgba(245,158,11,0.4)}
.kv{display:flex;justify-content:space-between;font-size:12px;margin:3px 0}
.btn{cursor:pointer;border:1px solid var(--border);background:var(--panel2);color:var(--text);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:500;transition:all .15s;display:inline-flex;align-items:center;gap:6px}
.btn:hover{border-color:var(--blue);background:rgba(59,130,246,0.1)}
.btn.primary{background:#2563eb;border-color:#3b82f6;color:#fff}
.btn.primary:hover{background:#1d4ed8}
.btn.on{background:rgba(16,185,129,0.2);border-color:var(--green);color:#6ee7b7}
.btn.off{background:rgba(239,68,68,0.2);border-color:var(--red);color:#fca5a5}
.btn:disabled{opacity:.5;cursor:not-allowed}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
th{color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.6px}
tr:hover td{background:rgba(255,255,255,0.02)}
.tag{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600}
.tag.ok{background:rgba(16,185,129,0.15);color:var(--green);border:1px solid rgba(16,185,129,0.3)}
.tag.fail{background:rgba(239,68,68,0.15);color:var(--red);border:1px solid rgba(239,68,68,0.3)}
pre{white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:11.5px;max-height:360px;overflow:auto;background:var(--panel2);padding:12px;border-radius:10px;border:1px solid var(--border)}
.msg{display:flex;gap:12px;padding:10px;border-radius:8px;margin-bottom:8px;font-size:12px}
.msg.text{background:rgba(16,185,129,0.08);border-left:3px solid var(--green)}
.msg.tool{background:rgba(245,158,11,0.08);border-left:3px solid var(--amber)}
.msg.part{background:rgba(59,130,246,0.08);border-left:3px solid var(--blue)}
.msg .who{min-width:70px;text-transform:uppercase;font-size:10px;font-weight:700;letter-spacing:.6px;color:var(--dim)}
.cell-session{cursor:pointer}
.cell-session:hover td{color:var(--blue);background:rgba(59,130,246,0.08)}
.spark{display:flex;align-items:flex-end;gap:2px;height:40px;margin-top:6px}
.spark div{flex:1;background:var(--blue);border-radius:2px;min-height:2px}
.spark div.g{background:var(--green)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.chip{font-size:11px;padding:2px 8px;border:1px solid var(--border);border-radius:12px;color:var(--dim);background:var(--panel2)}
#toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1e293b;border:1px solid var(--blue);color:var(--text);padding:10px 18px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.5);display:none;z-index:100;font-size:13px}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.tab{padding:6px 12px;border-radius:8px;font-size:12px;border:1px solid var(--border);background:var(--panel2);color:var(--dim);cursor:pointer}
.tab.active{background:rgba(59,130,246,0.2);border-color:var(--blue);color:#fff}
.pn{display:flex;flex-direction:column;align-items:center;gap:3px}
.pn-dot{width:12px;height:12px;border-radius:50%}
.pn-lbl{font-size:10.5px;color:var(--dim);font-weight:600}
.pn-arrow{font-size:16px;color:var(--blue);margin:0 2px}
.pn-arrow.amber{color:var(--amber)}
.amber{color:var(--amber)}
</style>
</head>
<body>

<div class="top-bar">
  <div>
    <h1><span class="dot ok"></span> OpenCode Loophole Control Center</h1>
    <div class="mini" id="sysline" style="margin-top:4px">Connecting to daemon…</div>
  </div>
  <div style="display:flex;align-items:center;gap:12px">
    <button class="btn primary" onclick="runSmokeTest()">⚡ Smoke Test Chain</button>
    <button class="btn" onclick="restartAll()">🔄 Restart All Services</button>
    <div class="mini mono" id="clock"></div>
  </div>
</div>

<h2>Loophole Services (Auto-starts on Boot)</h2>
<div class="grid cards" id="services"></div>

<h2>Live Loophole Telemetry &amp; Stats</h2>
<div class="grid cards">
  <div class="card">
    <div class="kv"><span class="dim">Total Bridge Requests</span><b id="st-total" class="mono">?</b></div>
    <div class="kv"><span class="dim">Successful (200 OK)</span><b id="st-ok" class="mono" style="color:var(--green)">?</b></div>
    <div class="kv"><span class="dim">Failed</span><b id="st-fail" class="mono" style="color:var(--red)">?</b></div>
  </div>
  <div class="card">
    <div class="kv"><span class="dim">Throughput (Last 60s)</span><b id="st-lastmin" class="mono">?</b></div>
    <div class="kv"><span class="dim">Average Latency</span><b id="st-avg" class="mono">?</b></div>
    <div class="kv"><span class="dim">Open Sessions</span><b id="st-sessioncount" class="mono">?</b></div>
  </div>
  <div class="card">
    <div class="kv"><span class="dim">System Workload (1m/5m/15m)</span><b id="st-load" class="mono">?</b></div>
    <div class="kv"><span class="dim">Memory Usage</span><b id="st-mem" class="mono">?</b></div>
    <div class="spark" id="st-spark"></div>
  </div>
  <div class="card">
    <div class="dim" style="font-size:11.5px">Active Models Used</div>
    <div class="chips" id="st-models"></div>
  </div>
</div>

<h2>Live Loophole Pipeline — Chain Flow</h2>
<div class="panel" style="padding:20px 24px">
  <div class="pipeline" style="display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:6px;margin-bottom:14px">
    <div class="pn"><div class="pn-dot ok"></div><div class="pn-lbl">Client</div></div>
    <div class="pn-arrow">→</div>
    <div class="pn"><div class="pn-dot ok"></div><div class="pn-lbl">Bridge :1343</div></div>
    <div class="pn-arrow">→</div>
    <div class="pn"><div class="pn-dot ok"></div><div class="pn-lbl">Serve :18765</div></div>
    <div class="pn-arrow">→</div>
    <div class="pn"><div class="pn-dot ok"></div><div class="pn-lbl">Rotator :1341</div></div>
    <div class="pn-arrow">→</div>
    <div class="pn"><div class="pn-dot ok"></div><div class="pn-lbl">zen</div></div>
    <div class="pn-arrow" style="color:var(--amber)">⚡</div>
    <div class="pn"><div class="pn-dot amber"></div><div class="pn-lbl">x-real-ip rotated</div></div>
  </div>
  <div class="kv"><span class="dim">Last Upstream Hops (rotating IPs proven)</span><b id="pipeline-proof" class="mono" style="color:var(--green)">checking…</b></div>
  <div class="kv"><span class="dim">Last Completion Path</span><b id="pipeline-path" class="mono">–</b></div>
  <div class="kv"><span class="dim">Last Model / Sample</span><b id="pipeline-model" class="mono">–</b></div>
</div>

<h2>Live Stream (real-time bridge completions)</h2>
<div class="panel">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
    <span class="mini dim">SSE events from bridge activity — auto-updates every 2s</span>
    <button class="btn" onclick="toggleStream()" id="streamBtn">▶ Start Stream</button>
  </div>
  <pre id="streamlog" style="max-height:200px;overflow:auto;font-size:11px">Waiting for stream…</pre>
</div>

<h2>What The Loophole Is Doing (Bridge Activity Stream)</h2>
<div class="panel">
  <table>
    <thead><tr><th>Time</th><th>Model</th><th>Mode</th><th>Status</th><th>Latency</th><th>Error/Details</th></tr></thead>
    <tbody id="activity"></tbody>
  </table>
</div>

<h2>What You Are Doing (OpenCode Live Sessions)</h2>
<div class="panel">
  <table>
    <thead><tr><th>Session Name</th><th>Active Model</th><th>Agent</th><th>Tokens (In / Out)</th><th>Last Updated</th></tr></thead>
    <tbody id="sessions"></tbody>
  </table>
</div>

<div id="transcript" class="panel" style="display:none;margin-top:14px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <b id="tr-title" class="mono" style="font-size:13.5px"></b>
    <button class="btn" onclick="closeTr()">✕ Close Viewer</button>
  </div>
  <div id="tr-body" style="max-height:480px;overflow:auto;padding-right:8px"></div>
</div>

<h2>Live Service Logs (journalctl)</h2>
<div class="panel">
  <div class="tabs" id="logtabs"></div>
  <pre id="logs">Loading service logs…</pre>
</div>

<div id="toast"></div>

<script>
const fmt = (ts)=> new Date(ts).toLocaleTimeString();
const ago = (ts)=>{ const s=Math.floor((Date.now()-ts)/1000); if(s<60)return s+'s ago'; if(s<3600)return Math.floor(s/60)+'m ago'; if(s<86400)return Math.floor(s/3600)+'h ago'; return Math.floor(s/86400)+'d ago'; };
const kv = (k,v,color)=> '<div class="kv"><span class="dim">'+k+'</span><b'+(color?' style="color:'+color+'"':'')+'>'+(v??'–')+'</b></div>';
const el = (id)=> document.getElementById(id);
async function api(p, opts){ const r=await fetch(p, { cache:'no-store', ...opts }); return r.json(); }

function toast(m){ const t=el('toast'); t.textContent=m; t.style.display='block'; setTimeout(()=>t.style.display='none',3200); }

let services=[];
async function refreshStatus(){
  try{
    const st=await api('/api/status');
    services=st.services;
    const box=el('services');
    box.innerHTML=services.map(s=>{
      const on = s.listen && s.systemd.active;
      const cls = s.listen ? (s.systemd.active?'ok':'hold') : 'bad';
      const hp = s.health ? s.health.status+' ('+s.health.ms+'ms)' : (s.listen?'active':'inactive');
      return '<div class="card">'
        +'<div>'
        +'<div class="card-header">'
        +'<h3><span class="dot '+cls+'"></span>'+s.label+'</h3>'
        +'<span class="badge '+(on?'ok':'bad')+'">'+(on?'ONLINE':'OFFLINE')+'</span>'
        +'</div>'
        +kv('Port', ':'+s.port)
        +kv('Systemd State', s.systemd.state, on?'var(--green)':'var(--red)')
        +kv('Health Check', hp)
        +kv('PID', s.systemd.pid || '–')
        +'<div class="mini dim" style="margin:8px 0 12px">'+s.desc+'</div>'
        +'</div>'
        +'<div style="display:flex;gap:8px">'
        +'<button class="btn tg '+(s.systemd.active?'on':'off')+'" data-unit="'+s.unit+'" data-active="'+s.systemd.active+'">'+(s.systemd.active?'Turn OFF':'Turn ON')+'</button>'
        +'<button class="btn rst" data-unit="'+s.unit+'">Restart</button>'
        +'</div></div>';
    }).join('');

    try{
      const sys=await api('/api/system');
      el('sysline').textContent = sys.hostname+' · '+sys.platform+' · Up '+Math.floor(sys.uptimeSec/3600)+'h · Node '+sys.node+' · Mem '+sys.memUsedPct+'% · Load '+sys.load.map(x=>x.toFixed(2)).join('/');
      el('st-load').textContent = sys.load.map(x=>x.toFixed(2)).join(' / ');
      el('st-mem').textContent = sys.memUsedPct+'%';
    }catch{}
  }catch(e){}
}

async function refreshActivity(){
  try{
    const a=await api('/api/activity');
    const agg=a.agg||{};
    el('st-total').textContent=agg.total||0;
    el('st-ok').textContent=agg.ok||0;
    el('st-fail').textContent=agg.fail||0;
    el('st-lastmin').textContent=(agg.lastMin||0)+' req/min';
    el('st-avg').textContent=agg.avgMs?agg.avgMs+'ms':'–';
    const mins=Object.keys(agg.perMin||{}).sort();
    el('st-spark').innerHTML = mins.length? mins.map(m=>{ const v=agg.perMin[m]; const h=Math.min(40,3+v*5); return '<div class="'+(v? 'g':'')+'" style="height:'+h+'px" title="'+fmt(Number(m))+' · '+v+' req"></div>'; }).join('') : '<div class="mini dim">no activity yet</div>';
    el('st-models').innerHTML = Object.entries(agg.byModel||{}).map(([m,c])=>'<span class="chip">'+m+' <b>×'+c+'</b></span>').join('') || '<span class="chip dim">none</span>';
    const tb=el('activity');
    tb.innerHTML = a.entries.length? a.entries.slice(0,50).reverse().map(e=>
      '<tr><td class="mono">'+fmt(e.ts||0)+'</td><td class="mono"><b>'+e.model+'</b></td><td>'+((e.stream)?'SSE stream':'JSON')+'</td><td><span class="tag '+((e.status===200)?'ok':'fail')+'">'+e.status+'</span></td><td class="mono">'+(e.ms!=null?e.ms+'ms':'–')+'</td><td class="dim" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+(e.error||'')+'</td></tr>'
    ).join('') : '<tr><td colspan="6" class="dim">No bridge activity recorded yet</td></tr>';
  }catch(e){}
}

async function refreshSessions(){
  try{
    const a=await api('/api/sessions?limit=15');
    if(!a.sessions || a.error){ el('st-sessioncount').textContent='–'; return; }
    el('st-sessioncount').textContent=a.sessions.length+' active';
    el('sessions').innerHTML = a.sessions.map(s=>{
      return '<tr class="cell-session" data-sid="'+s.id+'" data-title="'+escapeHtml(s.title||s.id)+'">'
        +'<td class="mono"><b>'+escapeHtml((s.title||s.id).slice(0,50))+'</b></td>'
        +'<td class="mono">'+escapeHtml(s.model||'–')+'</td>'
        +'<td>'+escapeHtml(s.agent||'–')+'</td>'
        +'<td class="mono">'+(s.tokensIn||0).toLocaleString()+' / '+(s.tokensOut||0).toLocaleString()+'</td>'
        +'<td class="dim">'+ago(s.updated||s.created)+'</td></tr>';
    }).join('');
  }catch(e){
    el('sessions').innerHTML='<tr><td colspan="5" class="dim">Unable to load sessions</td></tr>';
  }
}

async function openTr(id, title){
  try{
    const a=await api('/api/session/'+id);
    const body=el('tr-body');
    body.innerHTML=(a.messages&&a.messages.length)? a.messages.map(m=>{
      const t=(m.text||'').length>2500? m.text.slice(0,2500)+'…' : m.text||'';
      return '<div class="msg '+m.role+'"><div class="who">'+m.role+'</div><div class="mono" style="white-space:pre-wrap;flex:1">'+escapeHtml(t)+'</div></div>';
    }).join('') : '<div class="dim">No messages in this session</div>';
    el('tr-title').textContent='Session: '+(title || id)+' ('+(a.messages?a.messages.length:0)+' events)';
    el('transcript').style.display='block';
    el('transcript').scrollIntoView({ behavior: 'smooth' });
  }catch(e){}
}

document.addEventListener('click',(ev)=>{
  const row=ev.target.closest('.cell-session');
  if(row) openTr(row.dataset.sid, row.dataset.title);
  const tg=ev.target.closest('.tg');
  if(tg){ ctl(tg.dataset.unit, tg.dataset.active==='true'?'stop':'start'); }
  const rst=ev.target.closest('.rst');
  if(rst){ ctl(rst.dataset.unit,'restart'); }
});

function closeTr(){ el('transcript').style.display='none'; }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

let streamRunning=false;
async function toggleStream(){
  streamRunning=!streamRunning;
  const btn=el('streamBtn');
  if(streamRunning){
    btn.textContent='■ Stop Stream'; btn.className='btn off';
    const run=async ()=>{
      if(!streamRunning) return;
      try{
        const r=await fetch('/api/stream');
        const d=await r.json();
        if(d.entries && d.entries.length){
          el('streamlog').textContent=d.entries.map(e=>new Date(e.ts).toLocaleTimeString()+' '+e.model+' '+(e.stream?'[SSE]':'[JSON]')+' '+e.status+'ms'+(e.error?' ERR:'+e.error:'')+' path='+e.path).join('\n');
          el('streamlog').scrollTop=el('streamlog').scrollHeight;
          // update pipeline
          const last=d.entries[d.entries.length-1];
          el('pipeline-path').textContent=last.path||'–';
          el('pipeline-model').textContent=last.model||'–';
        }
      }catch{}
      if(streamRunning) setTimeout(run,2000);
    };
    run();
  } else {
    btn.textContent='▶ Start Stream'; btn.className='btn';
  }
}

async function refreshProof(){
  try{
    const p=await api('/api/proof');
    const proof=p.proof||{};
    const rp=p.rotatorProofs||[];
    // show last 3 upstream IPs
    const ips=(rp.slice(-3).reverse().map(e=>e.xRealIp).filter(Boolean));
    el('pipeline-proof').textContent=ips.length?ips.join(' → '):'–';
    el('pipeline-path').textContent=proof.path||'–';
    el('pipeline-model').textContent=(proof.model||proof.sample?proof.model+' · "'+proof.sample+'"':'checking…');
  }catch{}
}

async function runSmokeTest(){
  toast('Running smoke test against :1343...');
  try{
    const r=await api('/api/test-chain', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({model:'big-pickle'}) });
    if(r.ok){
      toast('✓ Smoke test passed in '+r.ms+'ms! Model: '+r.model+' -> "'+r.reply+'"');
    } else {
      toast('✗ Smoke test failed ('+r.status+'): '+r.reply);
    }
  }catch(e){ toast('Error testing chain: '+e.message); }
  setTimeout(refreshActivity, 500);
  setTimeout(refreshProof, 1000);
}

let curLog="zen-bridge.service";
async function refreshLogs(){
  const units = services.filter(s=>s.unit).map(s=>s.unit);
  if(!units.includes(curLog) && units.length) curLog=units[0];
  const tabs=el('logtabs');
  tabs.innerHTML=units.map(u=>'<div class="tab '+(curLog===u?'active':'')+'" onclick="pickLog(\''+u+'\')">'+u.replace('.service','')+'</div>').join('');
  try{
    const logEl=el('logs');
    const text=await (await fetch('/api/logs/'+curLog)).text();
    logEl.textContent=text;
    logEl.scrollTop=logEl.scrollHeight;
  }catch{}
}
function pickLog(u){ curLog=u; refreshLogs(); }

let busy=false;
async function ctl(unit,action){
  if(busy) return; busy=true;
  document.querySelectorAll('.btn').forEach(b=>b.disabled=true);
  toast(action.toUpperCase()+' '+unit+' ...');
  try{
    const r=await fetch('/api/service/'+unit+'/'+action,{method:'POST'});
    const j=await r.json();
    toast((j.ok?'✓ ':'✗ ')+action+' '+unit);
  }catch(e){ toast('Error: '+e.message); }
  document.querySelectorAll('.btn').forEach(b=>b.disabled=false);
  busy=false;
  setTimeout(refreshStatus,1000);
}

async function restartAll(){
  toast('Restarting all loophole services...');
  try{
    const r=await api('/api/restart-all', { method:'POST' });
    toast(r.ok ? '✓ All services restarted' : '✗ Restart failed');
  }catch(e){ toast('Error: '+e.message); }
  setTimeout(refreshStatus, 1200);
}

async function runSmokeTest(){
  toast('Running smoke test against :1343...');
  try{
    const r=await api('/api/test-chain', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({model:'big-pickle'}) });
    if(r.ok){
      toast('✓ Smoke test passed in '+r.ms+'ms! Model: '+r.model+' -> "'+r.reply+'"');
    } else {
      toast('✗ Smoke test failed ('+r.status+'): '+r.reply);
    }
  }catch(e){ toast('Error testing chain: '+e.message); }
  setTimeout(refreshActivity, 500);
}

setInterval(()=>{ const d=new Date(); el('clock').textContent=d.toLocaleDateString()+' '+d.toLocaleTimeString(); },1000);
async function loop(){
  await Promise.all([refreshStatus(),refreshActivity(),refreshSessions(),refreshProof()]);
  setTimeout(loop,3000);
}
setInterval(refreshLogs,5000);
loop();
refreshLogs();
</script>
</body>
</html>`;