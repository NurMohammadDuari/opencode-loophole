# opencode-zen-loophole

**Use all 40 free AI models from OpenCode — unlimited, no API key needed.**

This project runs a small local server on your machine that acts as a bridge between any AI coding tool and OpenCode's free AI models. It bypasses the daily usage limits by rotating IP addresses on every request.

**Verified working on:** Linux (Ubuntu/Mint) · Node.js v18+ · OpenCode v1.18.31

---

## What is this?

[OpenCode](https://opencode.ai) is a free AI coding assistant. It gives you access to 31+ free AI models, but limits how much you can use per day per IP address.

This project removes that limit by:
1. Running a local proxy server that looks like a standard OpenAI API
2. Wrapping every request in a real OpenCode client session
3. Spoofing a fresh random IP address on every single request so the rate limiter never triggers

The result: **unlimited free access** to 31 AI models from any tool that supports a custom API base URL (OpenCode, Cursor, VS Code extensions, aider, etc.)

---

## How it actually works

```
Your AI tool  (opencode, cursor, aider, etc.)
      │
      │  sends a normal API request to http://127.0.0.1:1343/v1
      ▼
┌─────────────────────────────────────────────┐
│  zen-bridge  (port 1343)                    │
│                                             │
│  • Accepts OpenAI-compatible requests       │
│  • Also accepts OpenAI Responses API        │
│  • Creates a real opencode session          │
│  • Streams live text back to your tool      │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│  opencode-serve  (port 18765)               │
│                                             │
│  • A real OpenCode client running locally   │
│  • Passes OpenCode's "real client" check    │
│  • Talks to the rotator, not directly       │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────┐
│  zen-rotator  (port 1341)                   │
│                                             │
│  • Injects a random X-Real-IP header        │
│  • Every request = new IP = fresh daily     │
│    bucket = unlimited usage                 │
└─────────────────┬───────────────────────────┘
                  │
                  ▼  (real HTTPS to opencode.ai)
         opencode.ai/zen/v1
         (the actual free AI models)
```

If the zen path fails for a model, the bridge automatically recovers with a smaller request body and falls back to `big-pickle` — no external fallback service needed.

---

## Free Models Available

### 31 Zen Free Models (via opencode.ai)
| Model ID | Notes |
|----------|-------|
| `big-pickle` | Default, fastest, most reliable |
| `muse-spark-1.3-contributor-free` | High quality |
| `muse-spark-1.2-contributor-free` | |
| `nemotron-3.5-lightning-free` | NVIDIA, fast |
| `nemotron-3-ultra-free` | NVIDIA, high quality |
| `nemotron-3-super-free` | |
| `deepseek-v4-flash-free` | Great for code |
| `mimo-v2.5-free` | |
| `mimo-v2-flash-free` | |
| `mimo-v2-omni-free` | |
| `mimo-v2-pro-free` | |
| `kimi-k2.5-free` | |
| `minimax-m2.1-free` | |
| `minimax-m2.5-free` | |
| `minimax-m3-free` | |
| `ling-2.6-flash-free` | |
| `ling-3.0-flash-free` | |
| `ling-3.0-flash-fin-free` | |
| `ling-3.0-tiny-free` | |
| `glm-4.7-free` | |
| `glm-5-free` | |
| `hy3-free` | |
| `hy3-preview-free` | |
| `jev-1.13-free` | |
| `laguna-s-2.1-free` | |
| `longcat-2.0-free` | |
| `north-mini-code-free` | Code focused |
| `qwen3.6-plus-free` | |
| `ring-2.6-1t-free` | |
| `trinity-large-preview-free` | |
| `x-preview-f-free` | |

---

## Requirements

Before installing, make sure you have:

- **Linux** (Ubuntu, Mint, Debian, Arch — any systemd distro)
- **Node.js v18 or newer** — [install with nvm](https://github.com/nvm-sh/nvm)
- **OpenCode** installed — [opencode.ai](https://opencode.ai)
- A free OpenCode account (sign up at opencode.ai — no credit card needed)

Check your versions:
```bash
node --version       # need v18+
opencode --version   # need any recent version
```

---

## Installation

### Step 1 — Clone this repo

```bash
git clone https://github.com/AmiXDme/opencode-zen-loophole.git
cd opencode-zen-loophole
```

### Step 2 — Create required directories

```bash
mkdir -p ~/.local/share/opencode/servehome/.local/share/opencode
mkdir -p ~/.local/share/opencode/servehome/.config/opencode
mkdir -p ~/.config/systemd/user
```

### Step 3 — Copy the scripts

```bash
# Main bridge script
cp scripts/zen-bridge.js   ~/.local/share/opencode/zen-bridge.js
cp scripts/zen-rotator.js  ~/.local/share/opencode/zen-rotator.js

# Models catalog
cp config/models-catalog.json ~/.local/share/opencode/models-catalog.json

# OpenCode config for the serve instance (points to rotator, not bridge)
cp config/serve-opencode.json \
   ~/.local/share/opencode/servehome/.config/opencode/opencode.json

# Dashboard
mkdir -p ~/.local/share/opencode/dashboard
cp dashboard/dashboard-server.js ~/.local/share/opencode/dashboard/

# Dashboard UI files
mkdir -p ~/.local/share/opencode/public
cp public/index.html public/style.css public/app.js \
   ~/.local/share/opencode/public/
```

### Step 4 — Install systemd services

```bash
cp services/zen-rotator.service      ~/.config/systemd/user/
cp services/opencode-serve.service   ~/.config/systemd/user/
cp services/zen-bridge.service       ~/.config/systemd/user/
cp services/opencode-dashboard.service ~/.config/systemd/user/

systemctl --user daemon-reload
```

### Step 5 — Log in to OpenCode

You need to be logged in to OpenCode so the bridge can use your free tier:

```bash
opencode auth login
```

Follow the prompts to log in with your OpenCode account.

### Step 7 — Start everything

```bash
systemctl --user enable --now zen-rotator.service
systemctl --user enable --now opencode-serve.service
systemctl --user enable --now zen-bridge.service
systemctl --user enable --now opencode-dashboard.service
```

The `--enable` flag makes them start automatically on every boot.

### Step 8 — Configure your OpenCode client

Edit your `~/.config/opencode/opencode.json` and point it at the bridge:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode/big-pickle",
  "provider": {
    "opencode": {
      "whitelist": [
        "big-pickle",
        "muse-spark-1.3-contributor-free",
        "deepseek-v4-flash-free",
        "nemotron-3.5-lightning-free",
        "nemotron-3-ultra-free",
        "mimo-v2.5-free",
        "kimi-k2.5-free",
        "glm-5-free",
        "hy3-free",
        "qwen3.6-plus-free"
      ],
      "options": {
        "baseURL": "http://127.0.0.1:1343/v1"
      }
    }
  }
}
```

You can add or remove models from the `whitelist` array — any model ID from the table above works.

---

## Verify It's Working

### Quick test
```bash
curl -s http://127.0.0.1:1343/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"say OK"}],"stream":false}' \
  | python3 -m json.tool
```

You should get back a response like:
```json
{
  "object": "chat.completion",
  "model": "big-pickle",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "OK"
      },
      "finish_reason": "stop"
    }
  ]
}
```

### Check all services are running
```bash
systemctl --user status zen-bridge opencode-serve zen-rotator opencode-dashboard
```

All should show `active (running)`.

### Open the live dashboard
```bash
xdg-open http://127.0.0.1:1395
```

You'll see a realtime control center: usage cards (requests, tokens in/out, context chars), a 30-minute activity chart, the live completion stream with per-request token/context details, service controls with logs, a chain tester, the model list, per-model usage stats, recent OpenCode sessions, and the rotator proof log.

---

## Using with Other Tools

Since the bridge is a standard OpenAI-compatible API, any tool that supports a custom base URL works.

### Cursor
Settings → AI → OpenAI → Base URL: `http://127.0.0.1:1343/v1`  
API Key: `not-needed` (any string works)

### Aider
```bash
aider --openai-api-base http://127.0.0.1:1343/v1 \
      --openai-api-key not-needed \
      --model big-pickle
```

### Continue.dev (VS Code extension)
In `~/.continue/config.json`:
```json
{
  "models": [{
    "title": "big-pickle (free)",
    "provider": "openai",
    "model": "big-pickle",
    "apiBase": "http://127.0.0.1:1343/v1",
    "apiKey": "not-needed"
  }]
}
```

### Python script
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:1343/v1",
    api_key="not-needed"
)

response = client.chat.completions.create(
    model="big-pickle",
    messages=[{"role": "user", "content": "Hello!"}]
)

print(response.choices[0].message.content)
```

---

## Service Details

| Service | Port | What it does |
|---------|------|-------------|
| **zen-bridge** | 1343 | Main API — accepts OpenAI chat/completions and Responses API requests |
| **opencode-serve** | 18765 | Real OpenCode client session — satisfies the "real client" auth check |
| **zen-rotator** | 1341 | Injects a random `X-Real-IP` on every request to reset the rate limit |
| **dashboard** | 1395 | Realtime web UI: usage/tokens, chart, services, logs, sessions, proof |

All services auto-restart if they crash (`Restart=always` in systemd units).

---

## Troubleshooting

### "Connection refused" when making requests
Services aren't running. Start them:
```bash
systemctl --user start zen-bridge opencode-serve zen-rotator
```

### "stream failed" errors in dashboard
Normal — happens occasionally when a zen token bucket is temporarily exhausted. The bridge automatically retries with a smaller body and falls back to big-pickle. You don't need to do anything.

### Dashboard shows "Waiting for stream…"
The activity log directory might be missing. Fix:
```bash
mkdir -p ~/.local/share/opencode/servehome/.local/share/opencode
systemctl --user restart zen-bridge opencode-dashboard
```

### opencode says "thinking" but no output
The serve config might be missing. Fix:
```bash
cp config/serve-opencode.json \
   ~/.local/share/opencode/servehome/.config/opencode/opencode.json
systemctl --user restart opencode-serve
```

### Check logs for any service
```bash
journalctl --user -u zen-bridge.service -f       # bridge logs
journalctl --user -u opencode-serve.service -f   # serve logs
journalctl --user -u zen-rotator.service -f      # rotator logs
```

---

## File Structure

```
opencode-zen-loophole/
│
├── scripts/
│   ├── zen-bridge.js       ← Main bridge server (OpenAI API compatible)
│   └── zen-rotator.js      ← IP rotation proxy
│
├── config/
│   ├── models-catalog.json ← List of all free models + remapping rules
│   ├── serve-opencode.json ← opencode.json for the serve instance
│   └── client-opencode.json← opencode.json for your opencode client
│
├── dashboard/
│   └── dashboard-server.js ← Web dashboard backend
│
├── public/
│   ├── index.html          ← Dashboard UI
│   ├── style.css           ← Retro theme
│   └── app.js              ← Realtime stream, usage cards, chart, controls
│
├── services/
│   ├── zen-bridge.service
│   ├── zen-rotator.service
│   ├── opencode-serve.service
│   └── opencode-dashboard.service
│
├── docs/                   ← Technical deep-dives
├── evidence/               ← Proof that it works
├── README.md               ← This file
└── LICENSE
```

---

## How the Rate Limit Bypass Works (Technical)

OpenCode's free tier gives each IP address a daily token budget. When you hit the limit, requests fail with a rate-limit error.

The `zen-rotator` sits between your local opencode-serve and the real `opencode.ai` server. For every request it forwards, it picks a random IP address from a large pool and injects it as the `X-Real-IP` header. The opencode.ai server trusts this header (it's designed for reverse proxies) and counts the request against that IP's bucket — not yours.

Since each request uses a different "IP", each request gets a fresh daily bucket. Effectively unlimited.

The `zen-bridge` adds one more layer: it creates a real opencode session for each request. This satisfies opencode.ai's check that the request comes from a real authenticated client (not just a raw HTTP call).

Result: unlimited free AI completions, routing through real infrastructure, with no simulation.

---

## Disclaimer

This project is for research and educational purposes. Using it may violate OpenCode's Terms of Service. You are responsible for how you use it. The authors are not liable for any consequences.

---

## License

MIT — see `LICENSE` for details.
