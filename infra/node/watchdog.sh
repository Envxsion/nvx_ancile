#!/usr/bin/env bash
# ==========================================================================
#  NVX Ancile · in-pod idle watchdog (backup only)
#
#  The Controller's idle rule is the primary auto-stop. This watchdog only
#  acts when the Controller has been unreachable for a while (no successful
#  heartbeat), so a laptop that is closed or offline can never leave a GPU
#  billing all night. It stops the pod (never terminates): storage and
#  weights survive.
#
#  Idle = GPU utilisation under ANCILE_IDLE_GPU_PCT and no new requests in
#  vLLM's request counter, continuously for ANCILE_IDLE_MINUTES.
# ==========================================================================
set -uo pipefail

IDLE_MINUTES="${ANCILE_IDLE_MINUTES:-45}"
IDLE_GPU_PCT="${ANCILE_IDLE_GPU_PCT:-5}"
HEARTBEAT_STALE_S="${ANCILE_HEARTBEAT_STALE_S:-600}"
PORT="${ANCILE_PORT:-8000}"
STATE_DIR=/run/ancile
INTERVAL=60

log() { printf '{"ts":"%s","level":"%s","service":"watchdog","msg":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "$2"; }

gpu_util() { # max utilisation across GPUs, or 0 if nvidia-smi is unavailable
  nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | sort -n | tail -1 | tr -d ' ' || echo 0
}

request_count() { # vLLM prometheus counter; total finished requests
  curl -fsS -m 3 "http://127.0.0.1:${PORT}/metrics" 2>/dev/null \
    | awk '/^vllm:request_success_total/ {s+=$NF} END {printf "%d", s}'
}

controller_alive() {
  [ -f "$STATE_DIR/last_heartbeat_ok" ] || return 1
  local last; last="$(cat "$STATE_DIR/last_heartbeat_ok")"
  [ $(( $(date +%s) - last )) -lt "$HEARTBEAT_STALE_S" ]
}

idle_since=""
last_count="$(request_count)"
log info "watching: stop after ${IDLE_MINUTES} min idle when the Controller is unreachable"

while sleep "$INTERVAL"; do
  util="$(gpu_util)"; util="${util:-0}"
  count="$(request_count)"; count="${count:-$last_count}"
  if [ "$util" -lt "$IDLE_GPU_PCT" ] && [ "$count" = "$last_count" ]; then
    idle_since="${idle_since:-$(date +%s)}"
  else
    idle_since=""
  fi
  last_count="$count"

  [ -n "$idle_since" ] || continue
  idle_min=$(( ($(date +%s) - idle_since) / 60 ))
  [ "$idle_min" -ge "$IDLE_MINUTES" ] || continue

  if controller_alive; then
    # The Controller is in charge; it applies the user's own idle rule.
    continue
  fi

  log warn "idle ${idle_min} min and Controller unreachable: stopping pod ${RUNPOD_POD_ID:-?}"
  if command -v runpodctl >/dev/null 2>&1 && [ -n "${RUNPOD_POD_ID:-}" ]; then
    runpodctl stop pod "$RUNPOD_POD_ID" && exit 0
    log error "runpodctl stop failed; will retry next interval"
  else
    log error "runpodctl or RUNPOD_POD_ID missing; cannot self-stop"
  fi
done
