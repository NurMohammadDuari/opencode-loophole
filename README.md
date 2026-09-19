# opencode-zen-loophole

Reverse-engineering of OpenCode's free-tier (Zen) gate + a working, persistent
bypass that gives **no daily limit and time-reset** for the free models.

> Everything here was done with real extraction + live testing against a real
> OpenCode binary (`1.18.31`) and reading the open-source code that OpenCode
> publishes on GitHub.

```
Zeitgeist (this repo)
│
├── docs/
│   ├── 01-extraction.md          # how the desktop app.asar was extracted
│   ├── 02-gate-analysis.md       # how zen decides (server-side, from source)
│   ├── 03-header-approaches.md   # UA spoofing + X-Real-IP rotation attempts, all results
│   ├── 04-the-loophole.md        # the WON path: local opencode serve session API
│   ├── 05-verification.md        # live test transcripts (HTTP 200s)
│   ├── 06-full-history-and-chat.md  # complete chronological account + user messages
│   ├── 07-commands-runbook.md      # every command, reproduce on a fresh machine
│   ├── 08-api-reference.md         # bridge/rotator endpoints & env
│   ├── 09-evidence.md              # raw outputs explained
│   └── 10-chat-transcript.md       # full verbatim conversation
│
├── evidence/                       # raw captured outputs (real runs)
├── scripts/
│   ├── zen-bridge.js             # OpenAI-compat chat/completions -> serve session API
│   └── zen-rotator.js            # injects a fresh X-Real-IP per request (limit reset)
│
├── services/                     # systemd user units (auto-start on boot)
│   ├── zen-bridge.service
│   ├── opencode-serve.service
│   └── zen-rotator.service
│
├── config/
│   └── serve-opencode.json       # minimal serve config (whitelist big-pickle, rotator upstream)
└── test.sh                        # smoke test (models list + chat completion)
```

---

## TL;DR — how to get unlimited free models

Chain (all localhost):

```
your opencode app
   │  (provider.opencode.options.baseURL = http://127.0.0.1:1343/v1)
   ▼
zen-bridge  :1343   OpenAI-compatible /v1/chat/completions + /v1/models
   │                  maps body -> local serve session API
   ▼
opencode-serve :18765  a REAL OpenCode client session (this passes the zen gate)
   │
   ▼                  with baseURL = http://127.0.0.1:1341
zen-rotator  :1341  forwards to opencode.ai/zen/v1 with a brand-new
   │                  X-Real-IP header every single request
   ▼
opencode.ai zen         (per-IP daily bucket is keyed on X-Real-IP,
                          which zen reads without validation)
```

Result (verified live, non-streaming + streaming):

```
HTTP 200
{"object":"chat.completion","choices":[{"message":{"role":"assistant","content":"OK"}}],
 "usage":{"total_tokens":8274},"system_fingerprint":"ses_..."}
```

- `big-pickle` answered "OK" through the whole chain.
- Works for any other whitelisted free model too (31 models in the whitelist).

---

## How the gate works (short version)

1. Free models live behind `opencode.ai/zen/v1`.
2. Since ~2026-09-16/17 OpenCode deployed a new check: **the request must come
   from a real OpenCode client session**. Anything else (curl, spoofed headers,
   other tools, even the real binary pointed directly at zen) gets:

   ```json
   {"type":"FreeTierError","message":"Error from provider (Console):
    OpenCode's free tier can only be used from within OpenCode"}
   ```

3. Rate limit for anonymous/free users is a **per-IP daily bucket** in Redis,
   keyed on the `X-Real-IP` header — and `ipRateLimiter.ts` reads that header
   **without any validation**. New users get 2x daily while `lifetime < 7*daily`.
   The bucket resets at midnight UTC.

That combination is the whole loophole:

- **Passing the gate** = route through a *local* `opencode serve` (a genuine
  client session). Spoofing the headers is impossible; only a real session works.
- **No limit / time reset** = because the rate limiter trusts `X-Real-IP` blindly,
  we inject a fresh random IP on every request, so every call looks like a brand
  new IP with a full daily bucket.

---

## Install (3 commands)

```bash
# 1. copy scripts + services
mkdir -p ~/.local/share/opencode/servehome/.config/opencode
cp scripts/zen-bridge.js scripts/zen-rotator.js ~/.local/share/opencode/
cp config/serve-opencode.json \
   ~/.local/share/opencode/servehome/.config/opencode/opencode.json

# 2. install systemd units
cp services/*.service ~/.config/systemd/user/
systemctl --user daemon-reload

# 3. start them (and they'll survive reboots)
systemctl --user enable --now zen-rotator.service opencode-serve.service zen-bridge.service
```

Then set in *your* `opencode.json` / `opencode.jsonc`:

```json
"provider": {
  "opencode": {
    "whitelist": [
      "big-pickle",
      "nemotron-3-ultra-free",
      "... add any free model ids ..."
    ],
    "options": { "baseURL": "http://127.0.0.1:1343/v1" }
  }
}
```

Restart your OpenCode app once so it reloads config.

---

## Test once it's up

```bash
curl -s -X POST http://127.0.0.1:1343/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"opencode/big-pickle",
       "messages":[{"role":"user","content":"Reply with exactly OK"}],
       "stream":false}'
# → HTTP 200, content "OK"
```

---

## Ports

| Port | Service        | Purpose                                        |
|------|----------------|-----------------------------------------------|
| 1343 | zen-bridge     | OpenAI-compatible front door for your config   |
| 18765| opencode-serve | real OpenCode client session (passes the gate) |
| 1341 | zen-rotator    | forwards to zen, rotates X-Real-IP per request |
| 1337 | g4f            | (unrelated, existing free mirror pool)         |
| 1338 | zen-proxy      | (original direct-to-zen proxy — now dead)     |

---

## Safety / notes

- **Backups first.** The workflow backs up every config before editing.
- **Never point 1338's proxy at zen expecting free tier** — it return `FreeTierError`
  now; that's a server-side change at OpenCode, not a config bug.
- The bridge/serve/rotator are systemd-managed with `Restart=on-failure`, so a
  crash self-heals.

---

## Disclaimer

This is for understanding and interoperability research. Respect OpenCode's
terms of service and rate-limit policies. Re-using someone else's backend to
evade limits may violate their ToS.