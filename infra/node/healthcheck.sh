#!/usr/bin/env bash
# NVX Ancile · node health: the server answers /v1/models and lists the
# expected model. Exit 0 healthy, 1 otherwise. Used by bootstrap.sh and
# as the container healthcheck.
set -euo pipefail
PORT="${ANCILE_PORT:-8000}"
NAME="${ANCILE_SERVED_NAME:-${ANCILE_MODEL:-}}"
# vLLM answers /health as soon as the engine is ready; cheapest first.
curl -fsS -m 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1
body="$(curl -fsS -m 5 -H "authorization: Bearer ${ANCILE_NODE_API_KEY:-}" "http://127.0.0.1:${PORT}/v1/models")" || exit 1
[ -z "$NAME" ] || printf '%s' "$body" | grep -qF "\"$NAME\"" || exit 1
exit 0
