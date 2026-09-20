// app.js – client side for the Loophole dashboard

let streamRunning = false;
let es = null;

function toggleStream() {
  streamRunning = !streamRunning;
  const btn = document.getElementById('streamBtn');
  if (streamRunning) {
    btn.textContent = '■ Stop Stream';
    btn.className = 'btn off';
    es = new EventSource('/api/stream');
    es.onopen = () => console.log('EventSource connection opened');
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.entries && d.entries.length) {
          const log = document.getElementById('streamlog');
          log.textContent = d.entries
            .map((en) => {
              const time = new Date(en.ts).toLocaleTimeString();
              const model = en.resolved || en.model || '?';
              const type = en.stream ? '[SSE]' : '[JSON]';
              const status = en.status;
              const ms = en.ms != null ? en.ms + 'ms' : '';
              const err = en.error ? ' ERR:' + en.error : '';
              const pathStr = 'path=' + (en.path || 'undefined');
              return `${time} ${model} ${type} ${status} ${ms}${err} ${pathStr}`;
            })
            .join('\n');
          log.scrollTop = log.scrollHeight;
          const last = d.entries[d.entries.length - 1];
          document.getElementById('pipeline-path').textContent = last.path || '–';
          document.getElementById('pipeline-model').textContent =
            last.resolved || last.model || '–';
        }
      } catch (err) {
        console.error('Error parsing SSE data', err);
      }
    };
    es.onerror = () => {
      console.error('EventSource error, closing');
      if (es) { es.close(); es = null; }
      streamRunning = false;
      const b = document.getElementById('streamBtn');
      b.textContent = '▶ Start Stream';
      b.className = 'btn';
      // No alert — just silently reset so the user can click Start again
    };
  } else {
    btn.textContent = '▶ Start Stream';
    btn.className = 'btn';
    if (es) { es.close(); es = null; }
  }
}

// Clock
function updateClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString();
}
setInterval(updateClock, 1000);
updateClock();

// Auto-start the SSE stream when the page loads; sync button to running state
document.addEventListener('DOMContentLoaded', () => {
  // Button starts as "▶ Start Stream" (off); toggleStream() flips it to running
  toggleStream();
});
