#!/usr/bin/env bash
set -euo pipefail

# Ensure dashboard server is up (systemd may still be starting after login)
for i in $(seq 1 40); do
  if curl -sf http://127.0.0.1:1395/api/status >/dev/null 2>&1; then
    break
  fi
  # Kick the unit if it isn't running yet
  if [ "$i" -eq 3 ]; then
    systemctl --user start opencode-dashboard.service >/dev/null 2>&1 || true
  fi
  sleep 0.5
done

PROFILE_DIR="${HOME}/.config/opencode-dashboard-chrome"
mkdir -p "$PROFILE_DIR"

URL="http://127.0.0.1:1395"

if command -v google-chrome >/dev/null 2>&1; then
  exec google-chrome \
    --user-data-dir="$PROFILE_DIR" \
    --app="$URL" \
    --class=OpenCodeDashboard \
    --no-first-run \
    --disable-extensions \
    "$@"
elif command -v chromium >/dev/null 2>&1; then
  exec chromium \
    --user-data-dir="$PROFILE_DIR" \
    --app="$URL" \
    --class=OpenCodeDashboard \
    --no-first-run \
    "$@"
elif command -v chromium-browser >/dev/null 2>&1; then
  exec chromium-browser \
    --user-data-dir="$PROFILE_DIR" \
    --app="$URL" \
    --class=OpenCodeDashboard \
    --no-first-run \
    "$@"
elif command -v firefox >/dev/null 2>&1; then
  exec firefox --new-window "$URL" "$@"
else
  exec xdg-open "$URL"
fi
