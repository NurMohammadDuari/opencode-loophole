// app.js – client side for the Loophole dashboard

let streamRunning = false;
let es = null;
let allModels = [];

/* ── helpers ── */
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ── stream log ── */
function formatEntry(en) {
  const time   = new Date(en.ts).toLocaleTimeString();
  const model  = en.resolved || en.model || '?';
  const type   = en.stream ? '[SSE]' : '[JSON]';
  const status = en.status != null ? en.status : '?';
  const ms     = en.ms != null ? en.ms + 'ms' : '';
  const err    = en.error ? ' ERR:' + en.error : '';
  const pth    = 'path=' + (en.path != null ? en.path : '–');
  return `${time} ${model} ${type} ${status} ${ms}${err} ${pth}`;
}

function renderLog(entries) {
  const log = document.getElementById('streamlog');
  const html = entries.map((en) => {
    const line  = formatEntry(en);
    const isErr = en.status !== 200 || !!en.error;
    return isErr
      ? '<span style="color:#cc3333">' + escHtml(line) + '</span>'
      : escHtml(line);
  }).join('\n');
  log.innerHTML = html;
  log.scrollTop = log.scrollHeight;
}

/* ── SSE stream toggle ── */
function toggleStream() {
  streamRunning = !streamRunning;
  const btn = document.getElementById('streamBtn');
  if (streamRunning) {
    btn.textContent = '■ Stop Stream';
    btn.className = 'btn off';
    es = new EventSource('/api/stream');
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (!d.entries || !d.entries.length) return;
        renderLog(d.entries);
        const last = d.entries[d.entries.length - 1];
        document.getElementById('pipeline-path').textContent  = last.path  != null ? last.path  : '–';
        document.getElementById('pipeline-model').textContent = last.resolved || last.model || '–';
      } catch (err) {
        console.error('SSE parse error', err);
      }
    };
    es.onerror = () => {
      if (es) { es.close(); es = null; }
      streamRunning = false;
      const b = document.getElementById('streamBtn');
      b.textContent = '▶ Start Stream';
      b.className = 'btn';
    };
  } else {
    btn.textContent = '▶ Start Stream';
    btn.className = 'btn';
    if (es) { es.close(); es = null; }
  }
}

/* ── models panel ── */
function loadModels() {
  const box = document.getElementById('model-list');
  box.textContent = 'Loading…';
  fetch('/v1/models')
    .then(r => r.json())
    .then(d => {
      allModels = (d.data || []).map(m => m.id).sort();
      renderModels(allModels);
    })
    .catch(e => { box.textContent = 'Error: ' + e.message; });
}

function filterModels() {
  const q = document.getElementById('model-filter').value.toLowerCase();
  renderModels(q ? allModels.filter(m => m.toLowerCase().includes(q)) : allModels);
}

function renderModels(list) {
  const box   = document.getElementById('model-list');
  const count = document.getElementById('model-count');
  count.textContent = '(' + list.length + ' models)';
  if (!list.length) { box.innerHTML = '<span class="dim">no models match</span>'; return; }
  box.innerHTML = list.map(id => {
    // strip "opencode/" prefix for display; badge live models green
    const short = id.replace(/^opencode\//, '');
    const isFast = !short.includes('-free') && short !== 'fast' && short !== 'fastest'
      ? false : true;
    return '<span class="model-badge' + (isFast ? ' live' : '') + '" title="' + escHtml(id) + '">'
      + escHtml(short) + '</span>';
  }).join('');
}

/* ── clock ── */
function updateClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString();
}
setInterval(updateClock, 1000);
updateClock();

/* ── init ── */
document.addEventListener('DOMContentLoaded', () => {
  toggleStream();
  loadModels();
});
