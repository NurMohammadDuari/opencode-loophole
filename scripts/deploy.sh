#!/usr/bin/env bash
# Deploy the fixed files from this repo to the live OpenCode runtime.
#   ./scripts/deploy.sh [--no-restart] [--no-test]
# Backs up (timestamped) every destination file that differs, syntax-checks
# the JS, restarts only the services whose files changed, waits for the
# bridge, then runs the ./test.sh smoke test.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$HOME/.local/share/opencode"
CFG="$HOME/.opencode"
TS="$(date +%Y%m%d-%H%M%S)"
DO_RESTART=1
DO_TEST=1
for a in "$@"; do
  case "$a" in
    --no-restart) DO_RESTART=0 ;;
    --no-test)    DO_TEST=0 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

SVC=() # services whose files changed
note_svc() { local s; for s in "${SVC[@]:-}"; do [ "$s" = "$1" ] && return; done; SVC+=("$1"); }

sync() { # sync <src> <dst> [service]
  local src="$1" dst="$2" svc="${3:-}"
  if ! cmp -s "$src" "$dst" 2>/dev/null; then
    if [ -f "$dst" ]; then
      cp -p "$dst" "$dst.bak-$TS"
      echo "backup  $dst.bak-$TS"
    fi
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    echo "updated $dst"
    [ -n "$svc" ] && note_svc "$svc"
  else
    echo "same    $dst"
  fi
}

echo "== repo: $REPO"

echo "== sync"
sync "$REPO/zen-bridge.js"               "$CFG/zen-bridge.js"                          zen-bridge
sync "$REPO/zen-bridge.js"               "$RUN/zen-bridge.js"                          zen-bridge
sync "$REPO/dashboard/dashboard-server.js" "$CFG/dashboard-server.js"                  opencode-dashboard
sync "$REPO/dashboard/dashboard-server.js" "$RUN/dashboard/dashboard-server.js"        opencode-dashboard
sync "$REPO/zen-rotator.js"              "$RUN/zen-rotator.js"                         zen-rotator
sync "$REPO/zen-proxy.js"                "$RUN/zen-proxy.js"                           zen-proxy
sync "$REPO/models-catalog.json"         "$RUN/models-catalog.json"
for f in app.js index.html style.css; do
  sync "$REPO/public/$f" "$RUN/public/$f"   opencode-dashboard
  sync "$REPO/public/$f" "$CFG/public/$f"
done

echo "== syntax check"
node --check "$RUN/zen-bridge.js"
node --check "$RUN/dashboard/dashboard-server.js"
node --check "$RUN/zen-rotator.js"
node --check "$RUN/zen-proxy.js"
echo "OK"

if [ "$DO_RESTART" = 1 ] && [ "${#SVC[@]}" -gt 0 ]; then
  echo "== restart: ${SVC[*]}"
  systemctl --user restart "${SVC[@]}"
  systemctl --user is-active "${SVC[@]}"
  echo "== waiting for bridge"
  for i in $(seq 1 15); do
    if curl -sf --max-time 2 http://127.0.0.1:1343/v1/models >/dev/null; then
      echo "bridge up (${i}s)"
      break
    fi
    sleep 1
  done
elif [ "${#SVC[@]}" -eq 0 ]; then
  echo "== nothing changed, no restart needed"
fi

if [ "$DO_TEST" = 1 ]; then
  echo "== smoke test"
  "$REPO/test.sh"
fi

echo "== deploy done (backups use suffix .bak-$TS)"
