/**
 * OpenCode Loophole Dashboard — realtime control center on :1395
 *
 * Feeds the UI everything over ONE SSE channel (/api/stream) — zen only, no g4f:
 *   - new bridge completions (tail-followed, no full-file re-reads)
 *   - aggregate usage: requests, tokens in/out, context chars, per-model stats
 *   - service status for the 4 zen units (probe + systemd + health)
 *   - system info
 *
 * Also exposes REST: /api/status /api/usage /api/system /api/activity
 *   /api/sessions /api/session/:id /api/logs/:unit /api/service/:unit/:action
 *   /api/restart-all /api/test-chain /api/proof /v1/models
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.DASHBOARD_PORT || 1395);
const HOME = os.homedir();
const SHARE = path.join(HOME, ".local", "share", "opencode");
const SERVEHOME_SHARE = path.join(SHARE, "servehome", ".local", "share", "opencode");

const _ACTIVITY_STANDARD = path.join(SHARE, "bridge-activity.jsonl");
const _ACTIVITY_SERVEHOME = path.join(SERVEHOME_SHARE, "bridge-activity.jsonl");

function resolveActivityLog() {
  if (process.env.BRIDGE_ACTIVITY_LOG) return process.env.BRIDGE_ACTIVITY_LOG;
  try {
    const sh = fs.existsSync(_ACTIVITY_SERVEHOME) ? fs.statSync(_ACTIVITY_SERVEHOME).mtimeMs : 0;
    const st = fs.existsSync(_ACTIVITY_STANDARD) ? fs.statSync(_ACTIVITY_STANDARD).mtimeMs : 0;
    if (sh && st) return sh >= st ? _ACTIVITY_SERVEHOME : _ACTIVITY_STANDARD;
    if (sh) return _ACTIVITY_SERVEHOME;
    if (st) return _ACTIVITY_STANDARD;
  } catch {}
  return _ACTIVITY_SERVEHOME;
}

// ── Tail-follow reader: remembers offset per path, only reads appended bytes ──
const tailState = new Map(); // path -> { offset, partial }
function tailRead(filePath, maxBytes = 262144) {
  let out = [];
  try {
    if (!fs.existsSync(filePath)) return out;
    const size = fs.statSync(filePath).size;
    let st = tailState.get(filePath);
    if (!st || size < st.offset) st = { offset: 0, partial: "" }; // truncated/rotated
    if (size === st.offset) return out;
    const start = Math.max(st.offset, size - maxBytes); // never read huge backlogs at once
    const fd = fs.openSync(filePath, "r");
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    st.offset = size;
    const text = (st.partial || "") + buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    st.partial = lines.pop() || ""; // last line may be incomplete
    tailState.set(filePath, st);
    for (const l of lines) {
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch {}
    }
  } catch {}
  return out;
}

function readActivity(limit = 300) {
  try {
    const p = resolveActivityLog();
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    return raw.split(/\r?\n/).filter(Boolean).slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ── Usage aggregation (in-memory ring + startup replay) ──────────────────────
const RING_MAX = 2000;
const ring = [];
const totals = { requests: 0, ok: 0, fail: 0, inTok: 0, outTok: 0, totalTok: 0, inChars: 0, outChars: 0, msSum: 0 };
const byModel = new Map(); // model -> {count, ok, fail, inTok, outTok, msSum, lastTs}
const byPath = new Map();

function normModel(m) {
  let s = String(m || "unknown").replace(/^opencode\//, "");
  return s || "unknown";
}

function ingest(e) {
  if (!e || typeof e !== "object") return;
  ring.push(e);
  if (ring.length > RING_MAX) ring.shift();
  const ok = e.status === 200;
  const tok = e.tokens || null;
  const inTok = tok ? (tok.input || tok.prompt || 0) : 0;
  const outTok = tok ? (tok.output || tok.completion || 0) : 0;
  const totTok = tok ? (tok.total || inTok + outTok) : 0;
  const reTok = tok ? (tok.reasoning || tok.reasoning_tokens || 0) : 0;
  const inC = e.inChars || 0, outC = e.outChars || 0;
  const ms = e.ms || 0;
  totals.requests++;
  if (ok) totals.ok++; else totals.fail++;
  totals.inTok += inTok; totals.outTok += outTok; totals.totalTok += totTok;
  totals.reasoningTok = (totals.reasoningTok || 0) + reTok;
  totals.inChars += inC; totals.outChars += outC; totals.msSum += ms;
  const m = normModel(e.resolved || e.model);
  let bm = byModel.get(m);
  if (!bm) { bm = { model: m, count: 0, ok: 0, fail: 0, inTok: 0, outTok: 0, reasoningTok: 0, msSum: 0, lastTs: 0 }; byModel.set(m, bm); }
  bm.count++; if (ok) bm.ok++; else bm.fail++;
  bm.inTok += inTok; bm.outTok += outTok; bm.reasoningTok = (bm.reasoningTok || 0) + reTok; bm.msSum += ms;
  bm.lastTs = e.ts || bm.lastTs;
  const p = e.path || (e.error ? "error" : "unknown");
  byPath.set(p, (byPath.get(p) || 0) + 1);
}

// Replay the recent log once at startup so totals survive dashboard restarts
(function replay() {
  const p = resolveActivityLog();
  for (const e of readActivity(5000)) ingest(e);
  // Seed the tail offset at EOF so the first tick doesn't re-ingest the same lines
  try { if (fs.existsSync(p)) tailState.set(p, { offset: fs.statSync(p).size, partial: "" }); } catch {}
  console.log("dashboard: replayed", ring.length, "activity entries");
})();

function usageSnapshot() {
  const now = Date.now();
  const perMin = new Map();
  for (const e of ring) {
    if (!e.ts || now - e.ts > 60 * 60 * 1000) continue;
    const k = Math.floor(e.ts / 60000) * 60000;
    let b = perMin.get(k);
    if (!b) { b = { ts: k, count: 0, inTok: 0, outTok: 0, fail: 0 }; perMin.set(k, b); }
    b.count++;
    const tok = e.tokens || null;
    if (tok) { b.inTok += tok.input || 0; b.outTok += tok.output || 0; }
    if (e.status !== 200) b.fail++;
  }
  const minutes = [];
  for (let i = 29; i >= 0; i--) {
    const k = Math.floor(now / 60000) * 60000 - i * 60000;
    minutes.push(perMin.get(k) || { ts: k, count: 0, inTok: 0, outTok: 0, fail: 0 });
  }
  const lastMin = minutes[minutes.length - 1];
  const models = [...byModel.values()].sort((a, b) => b.count - a.count);
  const daily = dailyUsage();
  return {
    ts: now,
    totals: {
      requests: totals.requests, ok: totals.ok, fail: totals.fail,
      inTok: totals.inTok, outTok: totals.outTok, totalTok: totals.totalTok,
      reasoningTok: totals.reasoningTok || 0,
      inChars: totals.inChars, outChars: totals.outChars,
      avgMs: totals.requests ? Math.round(totals.msSum / totals.requests) : 0,
      lastMinCount: lastMin ? lastMin.count : 0,
    },
    daily,
    today: daily.length ? daily[daily.length - 1] : null,
    contextLimits: CONTEXT_LIMITS,
    minutes,
    byModel: models,
    byPath: Object.fromEntries([...byPath.entries()].sort((a, b) => b[1] - a[1])),
    lastEntries: ring.slice(-50).reverse(),
    warnings: ring.slice(-200).filter((e) => e.context && e.context.level).slice(-10).reverse(),
  };
}

// ── Services ─────────────────────────────────────────────────────────────────
const SERVICES = [
  { name: "bridge", label: "Zen Bridge", port: 1343, unit: "zen-bridge.service", healthUrl: "http://127.0.0.1:1343/health",
    desc: "OpenAI /v1/chat/completions + /v1/responses -> local serve session API" },
  { name: "serve", label: "OpenCode Serve", port: 18765, unit: "opencode-serve.service", healthUrl: "",
    desc: "Real OpenCode client session (passes the zen Console gate)" },
  { name: "rotator", label: "Zen Rotator", port: 1341, unit: "zen-rotator.service", healthUrl: "",
    desc: "Rotates x-real-ip per request = fresh per-IP daily bucket" },
  { name: "proxy", label: "Zen Proxy", port: 1338, unit: "zen-proxy.service", healthUrl: "",
    desc: "Optional pacing proxy for direct token use (bypasses burst limits)" },
  { name: "dashboard", label: "Dashboard", port: 1395, unit: "opencode-dashboard.service", healthUrl: "",
    desc: "This control center" },
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
    return {
      active: props["ActiveState"] === "active",
      state: props["SubState"] || props["ActiveState"] || "unknown",
      pid: Number(props["MainPID"] || 0),
    };
  } catch { return { active: false, state: "unknown", pid: 0 }; }
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
  } catch (e) { return e.message; }
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

// ── Chain test ───────────────────────────────────────────────────────────────
function testBridgeChain(model = "big-pickle") {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const data = JSON.stringify({
      model: model.startsWith("opencode/") ? model : "opencode/" + model,
      messages: [{ role: "user", content: "Reply with OK" }],
      stream: false,
    });
    const req = http.request({
      hostname: "127.0.0.1", port: 1343, path: "/v1/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: 60000,
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(body); } catch {}
        const msg = json && json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message.content : (body || "");
        resolve({ ok: res.statusCode === 200, status: res.statusCode, ms: Date.now() - t0, model, reply: msg, usage: (json && json.usage) || null });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 408, ms: Date.now() - t0, model, reply: "timeout (60s)" }); });
    req.on("error", (e) => resolve({ ok: false, status: 500, ms: Date.now() - t0, model, reply: e.message }));
    req.write(data);
    req.end();
  });
}

// ── Sessions (read-only SQLite) ──────────────────────────────────────────────
const DB_CANDIDATES = [
  path.join(SERVEHOME_SHARE, "opencode.db"),
  path.join(SHARE, "opencode.db"),
];

// ── Token history: daily JSONL files written by the bridge ───────────────────
// The bridge runs with HOME=servehome, so it writes history INSIDE the serve
// home; the dashboard historically looked at SHARE/token-history (empty).
// Resolve dynamically: first candidate dir that actually has tokens-*.jsonl.
const HISTORY_DIRS = [
  process.env.TOKEN_HISTORY_DIR,
  path.join(SERVEHOME_SHARE, "token-history"),
  path.join(SHARE, "token-history"),
].filter(Boolean);
const DAILY_DAYS = 7;

function historyDir() {
  for (const dir of HISTORY_DIRS) {
    try {
      if (fs.readdirSync(dir).some((f) => /^tokens-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))) return dir;
    } catch {}
  }
  return HISTORY_DIRS[HISTORY_DIRS.length - 1];
}

function listHistoryFiles(days = DAILY_DAYS) {
  const dir = historyDir();
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^tokens-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .slice(-days);
  } catch { return []; }
}

function dailyUsage() {
  const days = [];
  for (const f of listHistoryFiles()) {
    const day = f.replace(/^tokens-/, "").replace(/\.jsonl$/, "");
    const agg = { day, requests: 0, ok: 0, fail: 0, inTok: 0, outTok: 0, totalTok: 0, inChars: 0, outChars: 0, msSum: 0, warnings: 0 };
    try {
      const raw = fs.readFileSync(path.join(historyDir(), f), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        agg.requests++;
        if (e.status === 200) agg.ok++; else agg.fail++;
        const tok = e.tokens || null;
        if (tok) {
          agg.inTok += tok.input || tok.prompt || 0;
          agg.outTok += tok.output || tok.completion || 0;
          agg.totalTok += tok.total || (tok.input || 0) + (tok.output || 0);
        }
        agg.inChars += e.inChars || 0;
        agg.outChars += e.outChars || 0;
        agg.msSum += e.ms || 0;
        if (e.context && e.context.level) agg.warnings++;
      }
    } catch {}
    days.push(agg);
  }
  return days;
}

// Context limits come from the same catalog the bridge uses
function loadContextLimits() {
  const candidates = [
    path.join(SERVEHOME_SHARE, "models-catalog.json"),
    path.join(SHARE, "models-catalog.json"),
    path.resolve(__dirname, "..", "models-catalog.json"),
    path.resolve(__dirname, "..", "config", "models-catalog.json"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const cat = JSON.parse(fs.readFileSync(c, "utf8"));
        if (cat.context_limits) return cat.context_limits;
      }
    } catch {}
  }
  return { _default: 128000 };
}
const CONTEXT_LIMITS = loadContextLimits();
let db = null;
function getDb() {
  if (db) { try { db.exec("SELECT 1"); return db; } catch { db = null; } }
  for (const p of DB_CANDIDATES) {
    try {
      if (!fs.existsSync(p)) continue;
      db = new DatabaseSync(p, { readOnly: true });
      db.prepare("SELECT 1 FROM session LIMIT 1").get();
      return db;
    } catch { db = null; }
  }
  return null;
}

function listSessions(limit = 20) {
  try {
    const d = getDb();
    if (!d) return [];
    const rows = d.prepare(
      `SELECT id, slug, title, model, agent, directory, time_created, time_updated, tokens_input, tokens_output, cost
       FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT ?`
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
  } catch (e) { return []; }
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
      if (text) out.push({ role: type, time: p.time_created, text });
    }
    return out;
  } catch (e) { return []; }
}

// ── Proof files ──────────────────────────────────────────────────────────────
function readProof() {
  const proofPath = process.env.BRIDGE_PROOF_FILE || path.join(SHARE, "loophole-proof.json");
  const rotPath = process.env.ROTATOR_PROOF_FILE || path.join(SHARE, "rotator-proof.jsonl");
  let proof = {}, rotatorProofs = [];
  try { proof = JSON.parse(fs.readFileSync(proofPath, "utf8")); } catch {}
  try {
    if (fs.existsSync(rotPath)) {
      const lines = fs.readFileSync(rotPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-20);
      rotatorProofs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
  } catch {}
  return { proof, rotatorProofs };
}

// ── SSE hub: one poller broadcasts to all clients ────────────────────────────
const sseClients = new Set();
let lastStatus = null;

setInterval(async () => {
  try {
    // Drain new activity entries since last tick
    const actPath = resolveActivityLog();
    const fresh = tailRead(actPath);
    for (const e of fresh) ingest(e);

    const s = await status();
    lastStatus = s;
    const payload = {
      ts: Date.now(),
      entries: fresh,
      usage: usageSnapshot(),
      status: s,
    };
    const frame = "data: " + JSON.stringify(payload) + "\n\n";
    for (const res of sseClients) {
      try { res.write(frame); } catch {}
    }
  } catch {}
}, 2000);

setInterval(() => {
  const sys = systemInfo();
  const frame = "data: " + JSON.stringify({ ts: Date.now(), system: sys }) + "\n\n";
  for (const res of sseClients) { try { res.write(frame); } catch {} }
}, 10000);

// ── HTTP plumbing ────────────────────────────────────────────────────────────
function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function sendText(res, code, text, type) {
  res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

// CSRF guard for state-changing endpoints: browsers attach Origin on cross-site POSTs
function originAllowed(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    const u = new URL(o);
    return ["127.0.0.1", "localhost", "::1"].includes(u.hostname);
  } catch { return false; }
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".json": "application/json",
};

const server = http.createServer(async (req, res) => {
  res.on("error", () => {});
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;

  try {
    const PUBLIC_ROOT = path.resolve(__dirname, "..", "public");
    if (p === "/" || p === "/index.html") {
      return sendText(res, 200, fs.readFileSync(path.join(PUBLIC_ROOT, "index.html"), "utf8"), "text/html; charset=utf-8");
    }
    const cleanPath = p.startsWith("/") ? p.slice(1) : p;
    const staticPath = path.resolve(PUBLIC_ROOT, cleanPath);
    if (staticPath.startsWith(PUBLIC_ROOT + path.sep) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      const data = fs.readFileSync(staticPath);
      return sendText(res, 200, data, MIME[path.extname(staticPath).toLowerCase()] || "application/octet-stream");
    }

    if (p === "/api/status" && req.method === "GET") return sendJson(res, 200, lastStatus || (await status()));
    if (p === "/api/system" && req.method === "GET") return sendJson(res, 200, systemInfo());
    if (p === "/api/activity" && req.method === "GET") return sendJson(res, 200, { ok: true, entries: readActivity(300), usage: usageSnapshot() });
    if (p === "/api/usage" && req.method === "GET") return sendJson(res, 200, usageSnapshot());

    if (p === "/api/sessions" && req.method === "GET")
      return sendJson(res, 200, { ok: true, sessions: listSessions(Number(u.searchParams.get("limit")) || 20) });
    if (p.startsWith("/api/session/") && req.method === "GET") {
      const id = p.slice("/api/session/".length);
      if (id) return sendJson(res, 200, { ok: true, id, messages: sessionMessages(id) });
    }

    if (p.startsWith("/api/logs/") && req.method === "GET") {
      const unit = p.slice("/api/logs/".length);
      if (!SERVICES.some((s) => s.unit === unit)) return sendJson(res, 400, { ok: false, error: "unknown unit" });
      return sendText(res, 200, unitLogs(unit, Number(u.searchParams.get("n")) || 200));
    }

    if (p.startsWith("/api/service/") && req.method === "POST") {
      if (!originAllowed(req)) return sendJson(res, 403, { ok: false, error: "cross-origin request blocked" });
      const rest = p.slice("/api/service/".length);
      const idx = rest.lastIndexOf("/");
      const unit = rest.slice(0, idx);
      const action = rest.slice(idx + 1);
      if (!SERVICES.some((s) => s.unit === unit)) return sendJson(res, 400, { ok: false, error: "unknown unit" });
      if (!["start", "stop", "restart"].includes(action)) return sendJson(res, 400, { ok: false, error: "bad action" });
      const r = sysctl(unit, action);
      return sendJson(res, r.ok ? 200 : 500, { ok: r.ok, action, unit, out: r.out, err: r.err });
    }

    if (p === "/api/restart-all" && req.method === "POST") {
      if (!originAllowed(req)) return sendJson(res, 403, { ok: false, error: "cross-origin request blocked" });
      const r1 = sysctl("zen-rotator.service", "restart");
      const r2 = sysctl("opencode-serve.service", "restart");
      const r3 = sysctl("zen-bridge.service", "restart");
      return sendJson(res, 200, { ok: r1.ok && r2.ok && r3.ok, msg: "All loophole services restarted (zen only)" });
    }

    if (p === "/api/test-chain" && req.method === "POST") {
      if (!originAllowed(req)) return sendJson(res, 403, { ok: false, error: "cross-origin request blocked" });
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

    if (p === "/api/proof" && req.method === "GET") return sendJson(res, 200, { ok: true, ...readProof() });

    if (p === "/api/stream" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": connected\n\n");
      sseClients.add(res);
      // Prime the client immediately with current state
      const first = { ts: Date.now(), entries: [], usage: usageSnapshot(), status: lastStatus || (await status()), system: systemInfo(), proof: readProof() };
      res.write("data: " + JSON.stringify(first) + "\n\n");
      req.on("close", () => { sseClients.delete(res); });
      return;
    }

    if ((p === "/v1/models" || p === "/models") && req.method === "GET") {
      const bridgeRes = await httpGet("http://127.0.0.1:1343/v1/models", 3000);
      if (bridgeRes.status === 200 && bridgeRes.json) return sendJson(res, 200, bridgeRes.json);
      return sendJson(res, 503, { ok: false, error: "bridge unreachable" });
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("OpenCode Loophole Dashboard listening on http://127.0.0.1:" + PORT);
});
