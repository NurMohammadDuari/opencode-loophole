// app.js — realtime client for the Loophole control center

let streamRunning = false;
let es = null;
let reconnectTimer = null;
let allModels = [];
let lastEntries = [];

/* ── helpers ── */
function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function $(id) { return document.getElementById(id); }
function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}
function setConn(on) {
  const dot = $("conn-dot");
  if (dot) dot.className = "dot " + (on ? "on" : "off");
}

/* ── usage cards ── */
function renderUsage(usage) {
  if (!usage || !usage.totals) return;
  const t = usage.totals;
  $("u-req").textContent = fmt(t.requests);
  $("u-ok").textContent = fmt(t.ok);
  $("u-fail").textContent = fmt(t.fail);
  $("u-intok").textContent = fmt(t.inTok);
  $("u-outtok").textContent = fmt(t.outTok);
  $("u-tok").textContent = fmt(t.totalTok);
  const reEl = $("u-retok");
  if (reEl) reEl.textContent = fmt(t.reasoningTok || 0);
  $("u-req-min").textContent = (t.lastMinCount || 0) + "/min";
  $("u-rate").textContent = t.requests ? Math.round((t.ok / t.requests) * 100) + "%" : "–";
  $("u-inchars").textContent = fmt(t.inChars) + " chars sent";
  $("u-outchars").textContent = fmt(t.outChars) + " chars received";
  $("u-avg").textContent = t.requests ? "avg " + (t.avgMs / 1000).toFixed(1) + "s" : "\u00a0";
  const today = usage.today;
  $("u-avgms").textContent = today
    ? "today " + fmt(today.totalTok) + " tok · " + today.requests + " req"
    : t.requests ? "avg " + (t.avgMs / 1000).toFixed(1) + "s / req" : "avg –";
  renderChart(usage.minutes || []);
  renderModelStats(usage.byModel || []);
  renderDaily(usage.daily || []);
  renderWarnings(usage);
}

/* ── 30-min bar chart ── */
function renderChart(minutes) {
  const chart = $("chart");
  if (!chart) return;
  if (!minutes.length) { chart.innerHTML = '<span class="dim">no data</span>'; return; }
  const max = Math.max(1, ...minutes.map((m) => m.count));
  chart.innerHTML = minutes.map((m) => {
    const h = Math.max(2, Math.round((m.count / max) * 100));
    const fail = m.fail > 0;
    const tip = new Date(m.ts).toLocaleTimeString() + " — " + m.count + " req"
      + (m.fail ? ", " + m.fail + " failed" : "")
      + (m.inTok || m.outTok ? ", tok " + m.inTok + "/" + m.outTok : "")
      + (m.reasoningTok ? ", R " + m.reasoningTok : "");
    return '<div class="bar' + (fail ? " bad" : "") + '" style="height:' + h + '%" title="' + escHtml(tip) + '"></div>';
  }).join("");
}

/* ── live completion log ── */
function fmtTokens(tok) {
  if (!tok) return "–";
  const i = tok.input || tok.prompt || 0;
  const o = tok.output || tok.completion || 0;
  return i + "→" + o;
}
function reasoningOf(tok) {
  return tok ? (tok.reasoning || tok.reasoning_tokens || 0) : 0;
}
function ctxBadge(ctx) {
  if (!ctx || !ctx.level) return "";
  const cls = ctx.level === "critical" ? "ctx-badge crit" : "ctx-badge warn";
  return ' <span class="' + cls + '">⚠ ' + ctx.pct + "%</span>";
}
function formatEntry(en) {
  const time = new Date(en.ts).toLocaleTimeString();
  const model = (en.resolved || en.model || "?").replace(/^opencode\//, "");
  const type = en.api === "responses" ? "[RESP]" : en.stream ? "[SSE]" : "[JSON]";
  const status = en.status != null ? en.status : "?";
  const ms = en.ms != null ? (en.ms / 1000).toFixed(1) + "s" : "";
  const tok = fmtTokens(en.tokens);
  const re = reasoningOf(en.tokens);
  const chars = en.inChars != null || en.outChars != null ? en.inChars + "›" + (en.outChars || 0) + "ch" : "";
  const err = en.error ? " ERR:" + String(en.error).slice(0, 60) : "";
  const pth = en.path || "–";
  return time + " " + model + " " + type + " " + status + " " + ms + " tok " + tok + (re > 0 ? " (R " + fmt(re) + ")" : "") + " " + chars + " " + pth + err + (en.context && en.context.level ? " [CTX " + en.context.pct + "%]" : "");
}
function renderLog(entries) {
  const log = $("streamlog");
  if (!entries || !entries.length) return;
  lastEntries = entries.concat(lastEntries).slice(0, 300);
  const html = lastEntries.map((en) => {
    const line = formatEntry(en);
    const isErr = en.status !== 200 || !!en.error;
    const warn = en.context && en.context.level;
    const cls = isErr ? "e" : warn ? (en.context.level === "critical" ? "ctx-crit" : "ctx-warn") : "";
    return cls ? '<span class="' + cls + '">' + escHtml(line) + "</span>" : escHtml(line);
  }).join("\n");
  log.innerHTML = html;
  log.scrollTop = log.scrollHeight;

  // Detail card for the most recent completion
  const last = entries[entries.length - 1];
  if (last) {
    const tok = last.tokens || null;
    const ctx = last.context || null;
    $("last-detail").innerHTML =
      '<b>' + escHtml((last.resolved || last.model || "?").replace(/^opencode\//, "")) + "</b>" +
      ' · path=' + escHtml(last.path || "–") +
      ' · ' + escHtml(String(last.ms != null ? (last.ms / 1000).toFixed(1) + "s" : "–")) +
      ' · tokens <span class="t">in ' + escHtml(fmtTokens(tok)) + "</span>" +
      (reasoningOf(tok) > 0 ? ' · <span class="t" title="reasoning tokens">R ' + escHtml(fmt(reasoningOf(tok))) + "</span>" : "") +
      ' · context <span class="t">' + escHtml((last.inChars || 0) + " chars in / " + (last.outChars || 0) + " out") + "</span>" +
      (ctx ? ' · <span class="' + (ctx.level === "critical" ? "e" : "t") + '">limit ' + escHtml(fmt(ctx.limit)) + " tok (" + ctx.pct + "%)" + (ctx.level ? " — " + escHtml(ctx.level) : "") + "</span>" : "") +
      (last.error ? ' · <span class="e">error: ' + escHtml(String(last.error).slice(0, 120)) + "</span>" : "");
  }
}

/* ── services ── */
function renderServices(status) {
  if (!status || !status.services) return;
  $("svc-list").innerHTML = status.services.map((s) => {
    const up = s.listen && s.systemd && s.systemd.active;
    const cls = up ? "svc ok" : "svc bad";
    const pid = s.systemd && s.systemd.pid ? " pid " + s.systemd.pid : "";
    const health = s.health ? " · health " + s.health.status + " (" + s.health.ms + "ms)" : "";
    const btns = s.name !== "dashboard"
      ? '<span class="svc-btns">'
        + '<button class="btn xs" onclick="svcAction(\'' + s.unit + '\',\'restart\')">↻</button>'
        + '<button class="btn xs" onclick="svcAction(\'' + s.unit + '\',\'stop\')">■</button>'
        + '<button class="btn xs" onclick="svcAction(\'' + s.unit + '\',\'start\')">▶</button>'
        + '<button class="btn xs" onclick="showLogs(\'' + s.unit + '\')">▤</button>'
        + "</span>"
      : "";
    return '<div class="' + cls + '">'
      + '<span class="dot ' + (up ? "on" : "off") + '"></span>'
      + "<b>" + escHtml(s.label) + "</b> <span class='dim'>:" + s.port + pid + health + "</span>"
      + "<br><span class='dim desc'>" + escHtml(s.desc) + "</span>"
      + btns + "</div>";
  }).join("");
}

/* ── daily history ── */
function renderDaily(daily) {
  const box = $("daily-stats");
  if (!box) return;
  if (!daily || !daily.length) { box.innerHTML = '<span class="dim">No history yet.</span>'; return; }
  const rows = daily.slice().reverse().map((d) => {
    const avg = d.requests ? Math.round(d.msSum / d.requests) : 0;
    return "<tr"
      + (d === daily[daily.length - 1] ? " class='today'" : "")
      + "><td class='mono'>" + escHtml(d.day) + "</td>"
      + "<td>" + d.requests + "</td>"
      + "<td>" + (d.fail ? "<span class='e'>" + d.fail + "</span>" : "0") + "</td>"
      + "<td class='t'>" + fmt(d.inTok) + "</td>"
      + "<td class='t'>" + fmt(d.outTok) + "</td>"
      + "<td class='t'>" + fmt(d.totalTok) + "</td>"
      + "<td>" + (d.warnings ? "<span class='e'>⚠ " + d.warnings + "</span>" : "0") + "</td>"
      + "<td>" + (avg / 1000).toFixed(1) + "s</td></tr>";
  }).join("");
  box.innerHTML = "<table><thead><tr><th>day</th><th>req</th><th>fail</th><th>tok in</th><th>tok out</th><th>total</th><th>ctx warns</th><th>avg</th></tr></thead><tbody>" + rows + "</tbody></table>";
}

/* ── context warning banner ── */
function renderWarnings(usage) {
  const box = $("ctx-banner");
  if (!box) return;
  const w = (usage && usage.warnings) || [];
  if (!w.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = w.slice(0, 3).map((e) => {
    const cls = e.context.level === "critical" ? "crit" : "warn";
    return '<div class="ctx-row ' + cls + '">⚠ <b>' + escHtml((e.resolved || e.model || "?").replace(/^opencode\//, ""))
      + "</b> " + escHtml(e.context.pct + "% of " + fmt(e.context.limit) + " tok")
      + " — " + escHtml(e.context.message || "") + "</div>";
  }).join("");
}

/* ── model stats ── */
function renderModelStats(models) {
  const box = $("model-stats");
  if (!models.length) { box.innerHTML = '<span class="dim">No data yet.</span>'; return; }
  const rows = models.slice(0, 12).map((m) => {
    const avg = m.count ? Math.round(m.msSum / m.count) : 0;
    const failPct = m.count ? Math.round((m.fail / m.count) * 100) : 0;
    return "<tr>"
      + "<td class='mono'>" + escHtml(m.model) + "</td>"
      + "<td>" + m.count + "</td>"
      + "<td>" + (m.fail ? "<span class='e'>" + m.fail + " (" + failPct + "%)</span>" : "0") + "</td>"
      + "<td class='t'>" + fmt(m.inTok) + "</td>"
      + "<td class='t'>" + fmt(m.outTok) + "</td>"
      + "<td>" + (avg / 1000).toFixed(1) + "s</td>"
      + "<td class='dim'>" + (m.lastTs ? new Date(m.lastTs).toLocaleTimeString() : "–") + "</td>"
      + "</tr>";
  }).join("");
  box.innerHTML = "<table><thead><tr><th>model</th><th>req</th><th>fail</th><th>tok in</th><th>tok out</th><th>avg</th><th>last</th></tr></thead><tbody>" + rows + "</tbody></table>";
}

/* ── SSE stream with auto-reconnect ── */
function startStream() {
  if (es) { try { es.close(); } catch (e) {} es = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  streamRunning = true;
  const btn = $("streamBtn");
  if (btn) { btn.textContent = "■ Stop Stream"; btn.className = "btn off"; }

  es = new EventSource("/api/stream");
  es.onopen = () => setConn(true);
  es.onmessage = (e) => {
    setConn(true);
    try {
      const d = JSON.parse(e.data);
      if (d.usage) renderUsage(d.usage);
      if (d.status) renderServices(d.status);
      if (d.system) renderSystem(d.system);
      if (d.entries && d.entries.length) renderLog(d.entries);
    } catch (err) { console.error("SSE parse error", err); }
  };
  es.onerror = () => {
    setConn(false);
    try { es.close(); } catch (e) {}
    es = null;
    if (!streamRunning) return;
    reconnectTimer = setTimeout(() => { if (streamRunning) startStream(); }, 3000);
  };
}
function stopStream() {
  streamRunning = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (es) { try { es.close(); } catch (e) {} es = null; }
  setConn(false);
  const btn = $("streamBtn");
  if (btn) { btn.textContent = "▶ Start Stream"; btn.className = "btn"; }
}
function toggleStream() { streamRunning ? stopStream() : startStream(); }

/* ── models ── */
function loadModels() {
  const box = $("model-list");
  box.textContent = "Loading…";
  fetch("/v1/models")
    .then((r) => r.json())
    .then((d) => {
      allModels = (d.data || []).map((m) => m.id).sort();
      renderModels(allModels);
    })
    .catch((e) => { box.textContent = "Error: " + e.message; });
}
function filterModels() {
  const q = $("model-filter").value.toLowerCase();
  renderModels(q ? allModels.filter((m) => m.toLowerCase().includes(q)) : allModels);
}
function renderModels(list) {
  const box = $("model-list");
  const count = $("model-count");
  count.textContent = "(" + list.length + " models)";
  if (!list.length) { box.innerHTML = '<span class="dim">no models match</span>'; return; }
  box.innerHTML = list.map((id) => {
    const short = id.replace(/^opencode\//, "");
    const isLive = short.includes("-free") || short === "big-pickle" || short === "fast" || short === "fastest";
    return '<span class="model-badge' + (isLive ? " live" : "") + '" title="' + escHtml(id) + '" onclick="testModel(\'' + escHtml(id) + '\')">' + escHtml(short) + "</span>";
  }).join("");
}
function testModel(id) {
  $("test-model").value = id.replace(/^opencode\//, "");
  runTest();
}

/* ── actions ── */
async function svcAction(unit, action) {
  try {
    const r = await fetch("/api/service/" + unit + "/" + action, { method: "POST" });
    const j = await r.json();
    console.log(unit, action, j);
  } catch (e) { console.error(e); }
}
function restartAll() {
  fetch("/api/restart-all", { method: "POST" }).catch(() => {});
}
function showLogs(unit) {
  $("panel-logs").hidden = false;
  $("logs-unit").textContent = unit;
  $("logs-view").textContent = "Loading…";
  fetch("/api/logs/" + unit + "?n=120")
    .then((r) => r.text())
    .then((t) => { $("logs-view").textContent = t; $("logs-view").scrollTop = $("logs-view").scrollHeight; })
    .catch((e) => { $("logs-view").textContent = "Error: " + e.message; });
}

/* ── chain test ── */
function runTest() {
  const out = $("test-result");
  const model = $("test-model").value.trim() || "big-pickle";
  out.textContent = "testing…";
  fetch("/api/test-chain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  })
    .then((r) => {
      const ctx = r.headers.get("x-context-warning");
      const pct = r.headers.get("x-context-usage");
      const lim = r.headers.get("x-context-limit");
      window.__testCtx = ctx ? { ctx, pct, lim } : null;
      return r.json();
    })
    .then((j) => {
      const c = window.__testCtx;
      out.innerHTML = j.ok
        ? '<span class="good">OK ' + (j.ms / 1000).toFixed(1) + "s — " + escHtml(String(j.reply).slice(0, 60)) + "</span>"
          + (c ? ' <span class="ctx-badge ' + (c.ctx === "critical" ? "crit" : "warn") + '">⚠ ' + escHtml(c.ctx + " " + c.pct + " of " + fmt(c.lim) + " tok") + "</span>" : "")
        : '<span class="e">FAIL ' + j.status + " — " + escHtml(String(j.reply).slice(0, 80)) + "</span>";
    })
    .catch((e) => { out.innerHTML = '<span class="e">error: ' + escHtml(e.message) + "</span>"; });
}

/* ── sessions ── */
function loadSessions() {
  $("panel-sessions").hidden = false;
  const box = $("session-list");
  box.textContent = "Loading…";
  fetch("/api/sessions?limit=15")
    .then((r) => r.json())
    .then((d) => {
      const ss = d.sessions || [];
      if (!ss.length) { box.innerHTML = '<span class="dim">no sessions found (or db locked)</span>'; return; }
      box.innerHTML = "<table><thead><tr><th>title</th><th>model</th><th>tok in</th><th>tok out</th><th>updated</th></tr></thead><tbody>"
        + ss.map((s) => "<tr>"
          + "<td class='mono'>" + escHtml(String(s.title || s.id).slice(0, 40)) + "</td>"
          + "<td class='mono'>" + escHtml(String(s.model || "–").replace(/^opencode\//, "")) + "</td>"
          + "<td class='t'>" + fmt(s.tokensIn) + "</td><td class='t'>" + fmt(s.tokensOut) + "</td>"
          + "<td class='dim'>" + (s.updated ? new Date(s.updated).toLocaleString() : "–") + "</td>"
          + "</tr>").join("")
        + "</tbody></table>";
    })
    .catch((e) => { box.textContent = "Error: " + e.message; });
}

/* ── proof ── */
function loadProof() {
  $("panel-proof").hidden = false;
  const box = $("proof-view");
  box.textContent = "Loading…";
  fetch("/api/proof")
    .then((r) => r.json())
    .then((d) => {
      let html = "";
      const p = d.proof || {};
      html += "<div class='proof-head'>last bridge proof: path=" + escHtml(p.path || "–")
        + " · model=" + escHtml(p.model || "–")
        + " · " + (p.ts ? new Date(p.ts).toLocaleTimeString() : "–")
        + " · sample=" + escHtml(String(p.sample || "–").slice(0, 40)) + "</div>";
      html += "<table><thead><tr><th>time</th><th>method</th><th>path</th><th>status</th><th>ms</th><th>x-real-ip</th></tr></thead><tbody>";
      const rows = (d.rotatorProofs || []).slice().reverse().slice(0, 15);
      for (const r of rows) {
        html += "<tr><td class='dim'>" + (r.ts ? new Date(r.ts).toLocaleTimeString() : "–") + "</td>"
          + "<td>" + escHtml(r.method || r.event || "–") + "</td>"
          + "<td class='mono'>" + escHtml(r.path || "–") + "</td>"
          + "<td>" + (r.status || "–") + "</td>"
          + "<td>" + (r.ms != null ? r.ms : "–") + "</td>"
          + "<td class='mono t'>" + escHtml(r.xRealIp || "–") + "</td></tr>";
      }
      html += "</tbody></table>";
      box.innerHTML = html;
    })
    .catch((e) => { box.textContent = "Error: " + e.message; });
}

/* ── system line ── */
function renderSystem(sys) {
  if (!sys) return;
  const el = document.querySelector(".top-right .sys");
  const txt = "load " + sys.load.map((x) => x.toFixed(1)).join(" ") + " · mem " + sys.memUsedPct + "%";
  if (el) el.textContent = txt;
}

/* ── clock ── */
function updateClock() { $("clock").textContent = new Date().toLocaleTimeString(); }
setInterval(updateClock, 1000);
updateClock();

/* ── init: prime REST state then start SSE ── */
document.addEventListener("DOMContentLoaded", () => {
  fetch("/api/activity").then((r) => r.json()).then((d) => {
    if (d.usage) renderUsage(d.usage);
    if (d.entries && d.entries.length) renderLog(d.entries.slice(-30).reverse());
  }).catch(() => {});
  startStream();
  loadModels();
});
