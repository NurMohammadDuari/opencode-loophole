#!/usr/bin/env bash
# ============================================================================
#   opencode-zen-loophole — clean uninstaller
#
#     bash scripts/uninstall.sh
#
#   Stops and removes the 4 services and deployed copies.
#   Your OpenCode login and client config are left untouched.
#   Pass --purge to also delete deployed data (activity logs, token history, servehome).
# ============================================================================
set -euo pipefail

B="\033[1m"; G="\033[32m"; Y="\033[33m"; N="\033[0m"
say() { echo -e "${G}==>${N} ${B}$*${N}"; }
warn() { echo -e "${Y}warn:${N} $*"; }

SHARE="$HOME/.local/share/opencode"
SERVEHOME="$SHARE/servehome"
UNIT_DIR="$HOME/.config/systemd/user"
UNITS=(zen-bridge.service opencode-serve.service zen-rotator.service opencode-dashboard.service)

say "Stopping and disabling services…"
systemctl --user stop "${UNITS[@]}" 2>/dev/null || true
systemctl --user disable "${UNITS[@]}" 2>/dev/null || true
systemctl --user daemon-reload

say "Removing unit files…"
for u in "${UNITS[@]}"; do rm -f "$UNIT_DIR/$u"; done
systemctl --user daemon-reload

say "Removing deployed files…"
rm -f "$SHARE/zen-bridge.js" "$SHARE/zen-rotator.js" "$SHARE/models-catalog.json"
rm -rf "$SHARE/dashboard" "$SHARE/public" "$SHARE/token-history"

if [[ "${1:-}" == "--purge" ]]; then
  warn "Purging servehome + activity/proof logs (auth and DB inside servehome will be deleted)…"
  rm -rf "$SERVEHOME"
  rm -f "$SHARE/bridge-activity.jsonl" "$SHARE/loophole-proof.json" "$SHARE/rotator-proof.jsonl"
else
  say "Kept $SERVEHOME and logs. Delete manually if you want:  rm -rf $SERVEHOME"
fi

echo
echo -e "${G}✔ Uninstalled.${N} Your ~/.config/opencode client config was left alone."
