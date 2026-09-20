// app.js – client side for the Loophole dashboard

let streamRunning = false;
let es = null;

function toggleStream() {
  console.log('toggleStream called, current state:', streamRunning);
  streamRunning = !streamRunning;
  const btn = document.getElementById('streamBtn');
  if (streamRunning) {
    btn.textContent = '■ Stop Stream';
    btn.className = 'btn off';
    es = new EventSource('/api/stream');
    es.onopen = () => console.log('EventSource connection opened');
    es.onmessage = (e) => {
      console.log('SSE raw data:', e.data);
      try {
        const d = JSON.parse(e.data);
        if (d.entries && d.entries.length) {
          const log = document.getElementById('streamlog');
          log.textContent = d.entries
            .map((en) =>
              new Date(en.ts).toLocaleTimeString() +
              ' ' +
              en.model +
              ' ' +
              (en.stream ? '[SSE]' : '[JSON]') +
              ' ' +
              en.status +
              'ms' +
              (en.error ? ' ERR:' + en.error : '') +
              ' path=' +
              en.path
            )
            .join('\n');
          log.scrollTop = log.scrollHeight;
          const last = d.entries[d.entries.length - 1];
          document.getElementById('pipeline-path').textContent = last.path || '–';
          document.getElementById('pipeline-model').textContent = last.model || '–';
        }
      } catch (err) {
        console.error('Error parsing SSE data', err);
      }
    };
    es.onerror = () => {
      console.error('EventSource error, closing');
      if (es) { es.close(); es = null; }
      streamRunning = false;
      btn.textContent = '▶ Start Stream';
      btn.className = 'btn';
      alert('Stream stopped due to error');
    };
  } else {
    console.log('Stopping stream');
    btn.textContent = '▶ Start Stream';
    btn.className = 'btn';
    if (es) { es.close(); es = null; }
  }
}

// Optional: display a clock
function updateClock() {
  const now = new Date();
  document.getElementById('clock').textContent = now.toLocaleTimeString();
}
setInterval(updateClock, 1000);
updateClock();
// Auto-start the SSE stream when the page loads
document.addEventListener('DOMContentLoaded', () => {
  toggleStream();
});
