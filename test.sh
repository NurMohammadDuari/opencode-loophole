#!/usr/bin/env bash
# Smoke test for the opencode-zen-loophole chain.
# Usage: ./test.sh [stream|json]
set -euo pipefail

BRIDGE="${BRIDGE:-http://127.0.0.1:1343}"
MODEL="${MODEL:-opencode/big-pickle}"
MODE="${1:-json}"

echo "== listing models via bridge =="
curl -sf "$BRIDGE/v1/models" | head -c 300
echo; echo

echo "== chat completion (mode=$MODE) =="
if [[ "$MODE" == "stream" ]]; then
  curl -sfN -X POST "$BRIDGE/v1/chat/completions" \
    -H 'content-type: application/json' \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly OK\"}],\"stream\":true}"
else
  curl -sf -X POST "$BRIDGE/v1/chat/completions" \
    -H 'content-type: application/json' \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly OK\"}],\"stream\":false}"
fi
echo

echo "== services =="
systemctl --user is-active zen-rotator opencode-serve zen-bridge
echo "OK"