#!/usr/bin/env bash
# ============================================================================
#   opencode-zen-loophole — one-command installer
#
#     bash scripts/install.sh
#
#   Deploys: zen-rotator, opencode-serve, zen-bridge, dashboard
#   Idempotent: safe to re-run any time (files are overwritten, services restarted)
# ============================================================================
set -euo pipefail

# ── pretty output ─────────────────────────────────────────────────────────────
B="\033[1m"; G="\033[32m"; Y="\033[33m"; R="\033[31m"; N="\033[0m"
say()  { echo -e "${G}==>${N} ${B}$*${N}"; }
warn() { echo -e "${Y}warn:${N} $*"; }
die()  { echo -e "${R}error:${N} $*" >&2; exit 1; }

# ── preflight ────────────────────────────────────────────────────────────────
say "Checking requirements…"

command -v systemctl >/dev/null || die "systemd user services required (any modern Linux distro)"
command -v curl >/dev/null || die "curl not found — install it (e.g. sudo apt install curl)"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  # nvm default install location
  for c in "$HOME"/.nvm/versions/node/*/bin/node; do
    [[ -x "$c" ]] && NODE_BIN="$c" && break
  done
fi
[[ -n "$NODE_BIN" ]] || die "node not found — install Node 18+ first (https://github.com/nvm-sh/nvm)"
NODE_VER="$("$NODE_BIN" --version)"
say "Node $NODE_VER at $NODE_BIN"

OPENCODE_BIN="$(command -v opencode || true)"
if [[ -z "$OPENCODE_BIN" ]]; then
  for c in "$HOME/.opencode/bin/opencode" /usr/local/bin/opencode /usr/bin/opencode; do
    [[ -x "$c" ]] && OPENCODE_BIN="$c" && break
  done
fi
[[ -n "$OPENCODE_BIN" ]] || die "opencode not found — install it first (curl -fsSL https://opencode.ai/install | bash)"
say "OpenCode at $OPENCODE_BIN"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
say "Repo: $REPO_DIR"

# ── layout ───────────────────────────────────────────────────────────────────
SHARE="$HOME/.local/share/opencode"
SERVEHOME="$SHARE/servehome"
UNIT_DIR="$HOME/.config/systemd/user"

say "Creating directories…"
mkdir -p "$SERVEHOME/.local/share/opencode" "$SERVEHOME/.config/opencode" "$UNIT_DIR" \
         "$SHARE/dashboard" "$SHARE/public" "$SHARE/token-history"

# ── deploy files ─────────────────────────────────────────────────────────────
say "Deploying scripts and UI…"
cp zen-bridge.js       "$SHARE/zen-bridge.js"
cp zen-rotator.js      "$SHARE/zen-rotator.js"
cp zen-proxy.js        "$SHARE/zen-proxy.js"
cp config/models-catalog.json "$SHARE/models-catalog.json"
cp config/models-catalog.json "$SERVEHOME/.local/share/opencode/models-catalog.json"
cp config/serve-opencode.json "$SERVEHOME/.config/opencode/opencode.json"
cp dashboard/dashboard-server.js "$SHARE/dashboard/"
cp public/index.html public/style.css public/app.js "$SHARE/public/"

# ── auth: reuse an existing OpenCode login if there is one ───────────────────
if [[ -f "$HOME/.local/share/opencode/auth.json" && ! -f "$SERVEHOME/.local/share/opencode/auth.json" ]]; then
  say "Linking your existing OpenCode login into the serve home…"
  cp "$HOME/.local/share/opencode/auth.json" "$SERVEHOME/.local/share/opencode/auth.json"
elif [[ ! -f "$SERVEHOME/.local/share/opencode/auth.json" ]]; then
  warn "No OpenCode login found yet."
  warn "After install, run:  ${B}HOME=$SERVEHOME opencode auth login${N}"
fi

# ── systemd units (paths templated for THIS machine) ────────────────────────
say "Writing systemd user units…"
# usage: make_unit NAME AFTER WANTS -- EXEC_AND_ARGS... [Environment=...]
make_unit() {
  local name="$1" after="$2" wants="$3"; shift 3
  [[ "${1:-}" == "--" ]] && shift
  local exec_parts=() envs=() arg
  for arg in "$@"; do
    if [[ "$arg" == Environment=* ]]; then envs+=("$arg"); else exec_parts+=("$arg"); fi
  done
  {
    echo "[Unit]"
    echo "Description=opencode-zen-loophole: $name"
    [[ -n "$after" ]] && echo "After=$after"
    [[ -n "$wants" ]] && echo "Wants=$wants"
    echo ""
    echo "[Service]"
    echo "Type=simple"
    echo "ExecStart=${exec_parts[*]}"
    local e
    for e in "${envs[@]}"; do echo "$e"; done
    echo "Restart=always"
    echo "RestartSec=3"
    echo ""
    echo "[Install]"
    echo "WantedBy=default.target"
  } > "$UNIT_DIR/$name"
}

make_unit "zen-rotator.service" "" "" -- \
  "$NODE_BIN" "$SHARE/zen-rotator.js" \
  Environment=ZEN_ROTATOR_PORT=1341 Environment=HOME="$HOME"

make_unit "opencode-serve.service" "zen-rotator.service" "zen-rotator.service" -- \
  "$OPENCODE_BIN" serve --port 18765 --hostname 127.0.0.1 \
  Environment=OPENCODE_SERVER_USERNAME=opencode Environment=OPENCODE_SERVER_PASSWORD=opencodepass \
  Environment=OPENCODE_DISABLE_AUTOUPDATE=1 Environment=HOME="$SERVEHOME"

make_unit "zen-bridge.service" "opencode-serve.service" "opencode-serve.service" -- \
  "$NODE_BIN" "$SHARE/zen-bridge.js" \
  Environment=BRIDGE_PORT=1343 Environment=SERVE_PORT=18765 \
  Environment=SERVE_USER=opencode Environment=SERVE_PASS=opencodepass \
  Environment=HOME="$SERVEHOME" Environment=FAST_RACE=0 \
  Environment=ZEN_TIMEOUT_MS=180000 Environment=EMPTY_STREAM_GRACE_MS=90000 \
  Environment=RECOVERY_TIMEOUT_MS=45000 Environment=RECOVERY_MAX_ATTEMPTS=3 \
  Environment=SESSION_TTL_MS=90000

make_unit "opencode-dashboard.service" "zen-bridge.service" "zen-bridge.service" -- \
  "$NODE_BIN" "$SHARE/dashboard/dashboard-server.js" \
  Environment=DASHBOARD_PORT=1395 Environment=HOME="$HOME"

# ── client config (only if the user has none yet) ────────────────────────────
CLIENT_CFG="$HOME/.config/opencode/opencode.json"
if [[ ! -f "$CLIENT_CFG" ]]; then
  say "Writing client config (points opencode at the bridge)…"
  mkdir -p "$HOME/.config/opencode"
  cp config/client-opencode.json "$CLIENT_CFG"
else
  say "Client config exists — leaving it alone."
  warn "Make sure provider.opencode.options.baseURL = http://127.0.0.1:1343/v1"
fi

# ── start services ───────────────────────────────────────────────────────────
say "Reloading systemd and starting services…"
systemctl --user daemon-reload
systemctl --user enable --quiet zen-rotator.service opencode-serve.service zen-bridge.service opencode-dashboard.service
systemctl --user restart zen-rotator.service opencode-serve.service zen-bridge.service opencode-dashboard.service

# ── verify ───────────────────────────────────────────────────────────────────
say "Waiting for services to come up…"
ok=0
for i in $(seq 1 20); do
  if curl -sf --max-time 2 http://127.0.0.1:1343/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[[ $ok -eq 1 ]] || die "bridge did not come up — check: journalctl --user -u zen-bridge.service -n 50"

systemctl --user is-active --quiet zen-rotator.service || die "zen-rotator not active"
systemctl --user is-active --quiet opencode-serve.service || die "opencode-serve not active"
systemctl --user is-active --quiet opencode-dashboard.service || die "opencode-dashboard not active"

cat <<'SUMMARY'

  ✔ Installed and running.

    Dashboard : http://127.0.0.1:1395
    API       : http://127.0.0.1:1343/v1   (OpenAI-compatible)

    Try it:
      curl -s http://127.0.0.1:1343/v1/chat/completions \
           -H 'content-type: application/json' \
           -d '{"model":"big-pickle","messages":[{"role":"user","content":"say OK"}]}'

    Manage : systemctl --user status zen-bridge opencode-serve zen-rotator opencode-dashboard
    Update : bash scripts/update.sh
    Remove : bash scripts/uninstall.sh
SUMMARY
