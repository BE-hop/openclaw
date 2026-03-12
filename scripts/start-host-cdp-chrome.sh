#!/usr/bin/env bash
set -euo pipefail

PORT="${OPENCLAW_HOST_CDP_PORT:-9222}"
PROFILE_DIR="${OPENCLAW_HOST_CDP_PROFILE_DIR:-/tmp/openclaw-remote-chrome}"

open -na "Google Chrome" --args \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="${PORT}" \
  --user-data-dir="${PROFILE_DIR}" \
  --no-first-run \
  --no-default-browser-check \
  about:blank

sleep 2
echo "CDP endpoint:"
curl -fsS "http://127.0.0.1:${PORT}/json/version" | head -c 300
echo
