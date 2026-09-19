#!/usr/bin/env bash
# Wait for dashboard server to be listening
for i in {1..20}; do
  if curl -s http://127.0.0.1:1395/api/status >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if command -v google-chrome >/dev/null 2>&1; then
  exec google-chrome --app="http://127.0.0.1:1395" "$@"
elif command -v chromium >/dev/null 2>&1; then
  exec chromium --app="http://127.0.0.1:1395" "$@"
elif command -v firefox >/dev/null 2>&1; then
  exec firefox --new-window "http://127.0.0.1:1395" "$@"
else
  exec xdg-open "http://127.0.0.1:1395"
fi
