#!/usr/bin/env bash
# ============================================================================
#   opencode-zen-loophole — update an existing install
#
#     bash scripts/update.sh
#
#   Pulls the latest code and redeploys. Auth, logs and client config untouched.
# ============================================================================
set -euo pipefail

B="\033[1m"; G="\033[32m"; N="\033[0m"
say() { echo -e "${G}==>${N} ${B}$*${N}"; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

say "Pulling latest code…"
git pull --ff-only origin "$(git rev-parse --abbrev-ref HEAD)"

say "Redeploying files…"
SHARE="$HOME/.local/share/opencode"
SERVEHOME="$SHARE/servehome"
mkdir -p "$SERVEHOME/.local/share/opencode" "$SERVEHOME/.config/opencode" "$SHARE/dashboard" "$SHARE/public" "$SHARE/token-history"
cp zen-bridge.js       "$SHARE/zen-bridge.js"
cp zen-rotator.js      "$SHARE/zen-rotator.js"
cp config/models-catalog.json "$SHARE/models-catalog.json"
cp config/models-catalog.json "$SERVEHOME/.local/share/opencode/models-catalog.json"
cp config/serve-opencode.json "$SERVEHOME/.config/opencode/opencode.json"
cp dashboard/dashboard-server.js "$SHARE/dashboard/"
cp public/index.html public/style.css public/app.js "$SHARE/public/"

say "Restarting services…"
systemctl --user restart zen-rotator.service opencode-serve.service zen-bridge.service opencode-dashboard.service
sleep 3

if curl -sf --max-time 3 http://127.0.0.1:1343/health >/dev/null 2>&1; then
  echo -e "${G}✔ Updated and healthy.${N}  Dashboard: http://127.0.0.1:1395"
else
  echo "bridge not healthy yet — check: journalctl --user -u zen-bridge.service -n 50"
  exit 1
fi
