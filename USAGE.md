# Dashboard — http://127.0.0.1:1395/

The dashboard is the realtime control center for the whole bridge chain.
Everything updates live over a single SSE connection (no page reloads).

## Quick start

```bash
# If installed as a user service (recommended):
systemctl --user status opencode-dashboard.service
xdg-open http://127.0.0.1:1395/

# Or run it manually from the repo:
node dashboard/dashboard-server.js
```

## What you get

| Panel | What it shows / does |
|-------|----------------------|
| **Usage cards** | Requests, OK, Failed, Tokens In, Tokens Out, Total Tokens — plus req/min, success rate, avg latency, chars sent/received |
| **Activity chart** | Bar chart of the last 30 minutes (requests/min; red bars = minutes with failures, hover for details) |
| **Live Completions** | Every request as it finishes: model, `[JSON]`/`[SSE]`/`[RESP]` tag, status, duration, **tokens in→out**, **context chars in›out**, path (zen-live / zen-sync / recovery), errors. A detail card breaks down the newest request |
| **Services** | All zen units with live status dots, PID, port, health — with restart / stop / start / log buttons per unit, plus a "Restart Zen Chain" button |
| **Chain Test** | Fires a real completion through the bridge for any model and shows OK/FAIL + latency. Click any model badge to test it |
| **Free Models** | Live list from the bridge (`/v1/models`) with filter |
| **Usage by Model** | Leaderboard: requests, failures, tokens in/out, average time, last used — per model |
| **Sessions** | Recent OpenCode sessions read read-only from `opencode.db` (title, model, token totals, updated) |
| **Logs** | `journalctl --user` output per service inside the page |
| **Proof** | Last bridge proof + recent rotator log entries, including the rotated `x-real-ip` addresses |

## REST API (all on :1395)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/stream` | GET (SSE) | Everything: usage, status, new completions (2s), system (10s) |
| `/api/usage` | GET | Aggregate usage: totals, per-minute buckets (30), per-model stats, last 50 entries |
| `/api/activity` | GET | Last 300 raw activity entries + usage snapshot |
| `/api/status` | GET | Service probe + systemd state + bridge health |
| `/api/system` | GET | Host info (load, memory, uptime, Node version) |
| `/api/sessions?limit=20` | GET | Recent OpenCode sessions (read-only SQLite) |
| `/api/session/:id` | GET | Message parts of one session |
| `/api/logs/:unit?n=200` | GET | journalctl logs for a unit |
| `/api/service/:unit/:action` | POST | start / stop / restart (localhost + same-origin only) |
| `/api/restart-all` | POST | Restart rotator + serve + bridge |
| `/api/test-chain` | POST | `{ "model": "big-pickle" }` → real completion through the bridge |
| `/api/proof` | GET | Bridge proof file + rotator proof log |
| `/v1/models` | GET | Proxied from the bridge |

## Troubleshooting

| Symptom | Check / Fix |
|---------|-------------|
| `node: command not found` | Install Node (`sudo apt install nodejs npm` or use nvm). |
| Port 1395 already in use | `ss -tlnp \| grep 1395`, kill the stale process or change `DASHBOARD_PORT`. |
| Service fails to start | `journalctl --user -u opencode-dashboard.service -b`. |
| Connection dot red / "Waiting for stream…" | The UI auto-reconnects every 3s; check that the dashboard service is running. |
| Token counters are 0 for old history | The bridge only started logging tokens recently — counters build up from now on. |
| Stats reset after dashboard restart | Recent history is replayed from `bridge-activity.jsonl` at startup; older entries beyond the replay window are not counted. |
