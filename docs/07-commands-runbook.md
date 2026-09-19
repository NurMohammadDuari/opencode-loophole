# 07 — Exact commands & session runbook (everything that was run)

A verbatim runbook of the commands that produced the working setup. Run these in
order to reproduce it on a fresh machine.

```bash
# =========================================================
# PHASE A : local OpenCode serve (real client session)
# =========================================================

# dedicated home so the serve NEVER reads your real config
mkdir -p ~/.local/share/opencode/servehome/.config/opencode

# minimal serve config: whitelist the models you want, and send
# the serve's own zen calls through the ROTATOR (port 1341)
cat > ~/.local/share/opencode/servehome/.config/opencode/opencode.json <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode/big-pickle",
  "provider": {
    "opencode": {
      "whitelist": ["big-pickle"],
      "options": {"baseURL": "http://127.0.0.1:1341"}
    }
  }
}
EOF

# start the serve (systemd does this; manual equivalent:)
export HOME=~/.local/share/opencode/servehome \
       OPENCODE_SERVER_USERNAME=opencode \
       OPENCODE_SERVER_PASSWORD=opencodepass \
       OPENCODE_DISABLE_AUTOUPDATE=1
opencode serve --port 18765 --hostname 127.0.0.1 &
# → "opencode server listening on http://127.0.0.1:18765"

# =========================================================
# PHASE B : rotator (fresh X-Real-IP per request)
# =========================================================
node ~/.local/share/opencode/zen-rotator.js &
# → "Zen rotator: http://127.0.0.1:1341 -> opencode.ai/zen/v1"

# =========================================================
# PHASE C : bridge (OpenAI-compat front door on 1343)
# =========================================================
BRIDGE_PORT=1343 SERVE_PORT=18765 \
SERVE_USER=opencode SERVE_PASS=opencodepass \
node ~/.local/share/opencode/zen-bridge.js &
# → "Zen bridge: http://127.0.0.1:1343 (OpenAI-compat) -> serve :18765 session API"

# =========================================================
# PHASE D : point YOUR client at the bridge
# =========================================================
# in ~/.config/opencode/opencode.json (and .jsonc, and project config):
#   "provider": { "opencode": {
#       "whitelist": ["big-pickle"],
#       "options": { "baseURL": "http://127.0.0.1:1343/v1" }
#   } }

# =========================================================
# PHASE E : systemd (auto-start, self-heal)
# =========================================================
cp ~/.local/share/opencode/zen-bridge.js  ~/.local/share/opencode/zen-rotator.js \
   ~/opencode-zen-loophole/scripts/          # (from this repo)
cp ~/opencode-zen-loophole/services/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now \
   zen-rotator.service opencode-serve.service zen-bridge.service

# status / logs
systemctl --user status zen-rotator opencode-serve zen-bridge
journalctl --user -u opencode-serve.service -f

# =========================================================
# PHASE F : verify
# =========================================================
curl -s http://127.0.0.1:1343/v1/models
curl -s -X POST http://127.0.0.1:1343/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"opencode/big-pickle",
       "messages":[{"role":"user","content":"Reply with exactly OK"}],
       "stream":false}'
```

---

## Diagnostics used along the way

```bash
# who's listening, what's using a port
ss -tlnp | grep -E ":1337|:1338|:1341|:1343|:18765"

# binary strings (headers/endpoints baked into the client)
strings -n 5 ~/.opencode/bin/opencode | grep -aiE "x-opencode|text/event|/session"

# desktop app evidence
grep -rn "1338\|baseURL\|zen" ~/.config/ai.opencode.desktop/opencode.global.dat

# session-API smoke test (python stdlib only)
python3 - <<'EOF'
import json, base64, urllib.request
BASE="http://127.0.0.1:18765"
AUTH="Basic "+base64.b64encode(b"opencode:opencodepass").decode()
def call(method,path,body=None,timeout=90):
    r=urllib.request.Request(BASE+path,method=method)
    r.add_header("content-type","application/json"); r.add_header("authorization",AUTH)
    if body is not None: r.data=json.dumps(body).encode()
    return urllib.request.urlopen(r,timeout=timeout).status, json.loads(urllib.request.urlopen(r,timeout=timeout).read())
EOF
```

## GitHub publish (this machine's quirk)

This machine rewrites `https://github.com/` → `https://gh-proxy.com/https://github.com/`
via a global git `insteadOf`. The first push therefore demanded `master` and went
through gh-proxy. Push with an explicit ref and correct default branch: `main`.

```bash
git remote add origin \
  https://github.com/AmiXDme/opencode-zen-loophole.git
git push -u origin main
# if still redirected, override for this repo only:
git config url."https://github.com/".insteadOf "https://gh-proxy.com/https://github.com/"
```