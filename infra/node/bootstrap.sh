#!/usr/bin/env bash
# ==========================================================================
#  NVX Ancile · remote node bootstrap (RunPod pod start command)
#
#  Turns a stock GPU pod into an OpenAI-compatible model server that the
#  Controller can route to. Idempotent: safe to run on every pod start.
#  Stateless: nothing here outlives the pod except model weights, which
#  live on the network volume at /workspace so restarts skip the download.
#
#  Environment (set on the pod template):
#    ANCILE_MODEL            HF model id to serve, e.g. Qwen/Qwen3-32B-AWQ   (required)
#    ANCILE_SERVED_NAME      name exposed on /v1/models (default: model id)
#    ANCILE_NODE_API_KEY     key vLLM requires on every request            (required)
#    ANCILE_PORT             serve port (default 8000; exposed via RunPod proxy)
#    ANCILE_VLLM_VERSION     pinned vLLM version (default below)
#    ANCILE_VLLM_ARGS        extra vLLM args, e.g. "--max-model-len 32768"
#    ANCILE_TOOL_PARSER      tool-call parser, e.g. hermes | llama3_json (enables tools)
#    CONTROLLER_URL          Controller base URL for heartbeats (optional)
#    CONTROLLER_NODE_TOKEN   token for heartbeats (required with CONTROLLER_URL)
#    HF_TOKEN                for gated models (optional)
#    ANCILE_NODE_SCRIPTS     where to fetch healthcheck.sh and watchdog.sh when
#                            this script was piped into bash (default: this repo)
#    RUNPOD_POD_ID           set by RunPod
#
#  Logs: /var/log/ancile/*.log (JSON lines from this script; vLLM's own log).
# ==========================================================================
set -euo pipefail

: "${ANCILE_MODEL:?set ANCILE_MODEL to the Hugging Face model id to serve}"
: "${ANCILE_NODE_API_KEY:?set ANCILE_NODE_API_KEY; the server refuses to start without one}"
ANCILE_SERVED_NAME="${ANCILE_SERVED_NAME:-$ANCILE_MODEL}"
ANCILE_PORT="${ANCILE_PORT:-8000}"
ANCILE_VLLM_VERSION="${ANCILE_VLLM_VERSION:-0.11.0}"
ANCILE_VLLM_ARGS="${ANCILE_VLLM_ARGS:-}"
VOLUME="${ANCILE_VOLUME:-/workspace}"
LOG_DIR=/var/log/ancile
STATE_DIR=/run/ancile            # tmpfs-like: gone when the pod stops, by design
NODE_ID="${RUNPOD_POD_ID:-$(hostname)}"
SCRIPTS_URL="${ANCILE_NODE_SCRIPTS:-https://raw.githubusercontent.com/Envxsion/nvx_ancile/main/infra/node}"

if [ -n "${CONTROLLER_URL:-}" ] && [ -z "${CONTROLLER_NODE_TOKEN:-}" ]; then
  echo "CONTROLLER_NODE_TOKEN is not set: heartbeats disabled, the Controller will poll RunPod instead." >&2
  CONTROLLER_URL=""
fi

mkdir -p "$LOG_DIR" "$STATE_DIR" "$VOLUME/hf-cache" "$VOLUME/venvs"

# The helpers sit beside this script, unless it was piped in (curl … | bash),
# when there is no "beside": fetch them next to the volume instead.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo /nonexistent)"
if [ ! -f "$HERE/healthcheck.sh" ] || [ ! -f "$HERE/watchdog.sh" ]; then
  HERE="$VOLUME/ancile-node"
  mkdir -p "$HERE"
  for f in healthcheck.sh watchdog.sh; do
    curl -fsSL -m 30 "$SCRIPTS_URL/$f" -o "$HERE/$f" \
      || { echo "could not fetch $f from $SCRIPTS_URL" >&2; exit 1; }
  done
  chmod +x "$HERE"/*.sh
fi
export HF_HOME="$VOLUME/hf-cache"
export HF_HUB_ENABLE_HF_TRANSFER=1

log() { # level msg [extra-json]
  printf '{"ts":"%s","level":"%s","service":"node","node":"%s","msg":"%s"%s}\n' \
    "$(date -u +%FT%TZ)" "$1" "$NODE_ID" "$2" "${3:+,$3}" | tee -a "$LOG_DIR/bootstrap.log"
}

heartbeat() { # state detail
  [ -n "${CONTROLLER_URL:-}" ] || return 0
  curl -fsS -m 5 -X POST "${CONTROLLER_URL%/}/control/v1/nodes/heartbeat" \
    -H "authorization: Bearer ${CONTROLLER_NODE_TOKEN}" \
    -H 'content-type: application/json' \
    -d "{\"provider_ref\":\"$NODE_ID\",\"state\":\"$1\",\"detail\":\"$2\",\"model\":\"$ANCILE_SERVED_NAME\",\"port\":$ANCILE_PORT}" \
    >/dev/null 2>&1 && date +%s > "$STATE_DIR/last_heartbeat_ok" || true
}

# --- 1. Python env with a pinned vLLM, cached on the volume ----------------
VENV="$VOLUME/venvs/vllm-$ANCILE_VLLM_VERSION"
if [ ! -x "$VENV/bin/vllm" ]; then
  log info "installing vllm $ANCILE_VLLM_VERSION into $VENV"
  heartbeat starting "installing vLLM $ANCILE_VLLM_VERSION"
  command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  uv venv --python 3.12 "$VENV"
  VIRTUAL_ENV="$VENV" uv pip install "vllm==$ANCILE_VLLM_VERSION" hf_transfer
else
  log info "vllm $ANCILE_VLLM_VERSION already installed"
fi

# --- 2. Weights on the volume (no-op when present) --------------------------
heartbeat starting "fetching weights for $ANCILE_MODEL"
log info "ensuring weights" "\"model\":\"$ANCILE_MODEL\""
# huggingface_hub 1.x names its CLI `hf`; older releases `huggingface-cli`.
HF_CLI="$VENV/bin/hf"; [ -x "$HF_CLI" ] || HF_CLI="$VENV/bin/huggingface-cli"
"$HF_CLI" download "$ANCILE_MODEL" >/dev/null 2>>"$LOG_DIR/bootstrap.log" \
  || { log error "weight download failed; check HF_TOKEN for gated models and volume free space"; heartbeat error "weight download failed"; exit 1; }

# --- 3. Serve (replace any server left from a previous run of this script) --
if [ -f "$STATE_DIR/vllm.pid" ] && kill -0 "$(cat "$STATE_DIR/vllm.pid")" 2>/dev/null; then
  log info "stopping previous vllm"
  kill "$(cat "$STATE_DIR/vllm.pid")" || true
  sleep 3
fi

TOOL_ARGS=()
if [ -n "${ANCILE_TOOL_PARSER:-}" ]; then
  TOOL_ARGS=(--enable-auto-tool-choice --tool-call-parser "$ANCILE_TOOL_PARSER")
fi

heartbeat starting "loading $ANCILE_SERVED_NAME into GPU memory"
# shellcheck disable=SC2086
nohup "$VENV/bin/vllm" serve "$ANCILE_MODEL" \
  --host 0.0.0.0 --port "$ANCILE_PORT" \
  --api-key "$ANCILE_NODE_API_KEY" \
  --served-model-name "$ANCILE_SERVED_NAME" \
  --enable-prefix-caching \
  "${TOOL_ARGS[@]}" $ANCILE_VLLM_ARGS \
  >>"$LOG_DIR/vllm.log" 2>&1 &
echo $! > "$STATE_DIR/vllm.pid"
log info "vllm launched" "\"pid\":$(cat "$STATE_DIR/vllm.pid")"

# --- 4. Wait for /v1/models, then report ready ------------------------------
for i in $(seq 1 180); do   # up to 15 minutes for very large models
  if "$HERE/healthcheck.sh" >/dev/null 2>&1; then
    log info "ready" "\"waited_s\":$((i * 5))"
    heartbeat running "serving $ANCILE_SERVED_NAME"
    break
  fi
  if ! kill -0 "$(cat "$STATE_DIR/vllm.pid")" 2>/dev/null; then
    log error "vllm exited during startup; last lines follow in vllm.log"
    tail -n 30 "$LOG_DIR/vllm.log" >&2 || true
    heartbeat error "vLLM exited during startup (often out of GPU memory: lower --max-model-len or use a quantised model)"
    exit 1
  fi
  sleep 5
done

if ! "$HERE/healthcheck.sh" >/dev/null 2>&1; then
  log error "not healthy after 15 minutes"
  heartbeat error "not healthy after 15 minutes"
  exit 1
fi

# --- 5. Backup idle watchdog + heartbeat loop --------------------------------
nohup "$HERE/watchdog.sh" >>"$LOG_DIR/watchdog.log" 2>&1 &
echo $! > "$STATE_DIR/watchdog.pid"

while sleep 30; do
  if "$HERE/healthcheck.sh" >/dev/null 2>&1; then
    heartbeat running "serving $ANCILE_SERVED_NAME"
  else
    heartbeat error "health check failing"
  fi
done
