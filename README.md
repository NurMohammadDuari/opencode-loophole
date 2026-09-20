# opencode‑zen‑loophole

**A local workaround that removes the daily usage limits of OpenCode’s free‑tier (Zen) models.**

The repository contains a small set of services that together emulate a free‑tier OpenCode client while bypassing the per‑IP rate‑limiting gate.

---

## Overview

```
your‑opencode‑app
   │  (provider.opencode.options.baseURL = http://127.0.0.1:1343/v1)
   ▼
zen‑bridge   :1343   ← OpenAI‑compatible /v1/chat/completions + /v1/models
   │                  forwards request body to the local serve‑session API
   ▼
opencode‑serve :18765  ← Real OpenCode client session (passes the Zen gate)
   │
   ▼                baseURL = http://127.0.0.1:1341
zen‑rotator   :1341   ← Injects a fresh `X‑Real‑IP` header for every request
   ▼
opencode.ai  zen        ← Free‑tier endpoint (per‑IP daily bucket)
```

* **zen‑bridge** exposes an OpenAI‑compatible endpoint that your OpenCode client can point to.
* **zen‑rotator** rewrites the request with a random `X‑Real‑IP`, tricking the server’s rate‑limiter.
* **opencode‑serve** runs a genuine OpenCode client session, satisfying the server’s “must be a real client” check.

The result is an **unlimited** free‑tier experience for any of the whitelisted models.

---

## Quick Install (3 commands)
```bash
# 1. Copy scripts and config
mkdir -p ~/.local/share/opencode/servehome/.config/opencode
cp scripts/zen-bridge.js scripts/zen-rotator.js ~/.local/share/opencode/
cp config/serve-opencode.json \
   ~/.local/share/opencode/servehome/.config/opencode/opencode.json

# 2. Install systemd user units
cp services/*.service ~/.config/systemd/user/
systemctl --user daemon-reload

# 3. Enable & start the services (they survive reboots)
systemctl --user enable --now zen-rotator.service \
                               opencode-serve.service \
                               zen-bridge.service
```

Add the following snippet to *your* `opencode.json` (or `opencode.jsonc`):
```json
"provider": {
  "opencode": {
    "whitelist": ["big-pickle", "nemotron-3-ultra-free", "…any other free model…"],
    "options": { "baseURL": "http://127.0.0.1:1343/v1" }
  }
}
```

Restart OpenCode so it picks up the new configuration.

---

## UI Refactor
The original server embedded a large HTML string. It has been replaced with a **static‑file server** that serves the UI from the new `public/` directory:
* `public/index.html` – basic page loading the stylesheet and client script.
* `public/style.css` – dark‑theme CSS (same variables as before).
* `public/app.js` – creates an `EventSource('/api/stream')` and updates the UI.

The server (`dashboard/dashboard‑server.js`) now serves static assets before handling API routes, making the UI easier to edit and debug.

---

## Running the Dashboard
```bash
cd dashboard
./launch-dashboard.sh   # opens Chromium in app‑mode on http://127.0.0.1:1395
```
The UI connects to the `/api/stream` endpoint and displays real‑time telemetry from the services.

---

## Service Overview
| Port | Service | Purpose |
|------|---------|---------|
| 1343 | **zen‑bridge** | OpenAI‑compatible front‑door for your config |
| 18765| **opencode‑serve** | Real OpenCode client session (passes the gate) |
| 1341 | **zen‑rotator** | Rotates `X‑Real‑IP` per request |
| 1337 | **g4f** | Unrelated free mirror pool |
| 1338 | **zen‑proxy** | Original direct‑to‑zen proxy (now disabled) |

---

## Testing
```bash
curl -s -X POST http://127.0.0.1:1343/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"opencode/big-pickle","messages":[{"role":"user","content":"Reply with exactly OK"}],"stream":false}'
# → {"object":"chat.completion","choices":[{"message":{"role":"assistant","content":"OK"}}],"usage":{...}}
```

---

## Safety & Notes
* **Back up** your original configuration before applying these changes.
* The workaround relies on the server trusting the `X‑Real‑IP` header without validation – if OpenCode tightens this check the bypass will stop working.
* Systemd units are configured with `Restart=on‑failure` for self‑healing.

---

## Disclaimer
This repository is for research and interoperability purposes only. Respect OpenCode’s terms of service and rate‑limit policies. Using this workaround to evade limits may violate the provider’s ToS.

---

## License
Distributed under the **MIT License** – see `LICENSE` for details.
