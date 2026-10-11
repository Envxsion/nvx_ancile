#!/usr/bin/env bash
# ==========================================================================
#  NVX Ancile · remote node bootstrap (RunPod pod start command)
#
#  Turns a GPU pod into an OpenAI-compatible model server that the
#  Controller can route to. Best run in the vLLM image (vllm/vllm-openai)
#  with the entrypoint replaced by this script: its vLLM already matches
#  the image's CUDA. In any other image a pinned vLLM is installed once
#  into the volume. Idempotent: safe to run on every pod start.
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
#    ANCILE_STATUS_PORT      when set, a plain-text status page on that port
#                            (this script's log, node key removed), for diagnosis
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

# curl when the image has it, Python otherwise (the vLLM image has Python).
fetch() { # url dest
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -m 60 "$1" -o "$2"
  else
    python3 -c 'import sys, urllib.request; open(sys.argv[2], "wb").write(urllib.request.urlopen(sys.argv[1], timeout=60).read())' "$1" "$2"
  fi
}

# The helpers sit beside this script, unless it was piped in (curl … | bash),
# when there is no "beside": fetch them next to the volume instead.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo /nonexistent)"
if [ ! -f "$HERE/healthcheck.sh" ] || [ ! -f "$HERE/watchdog.sh" ]; then
  HERE="$VOLUME/ancile-node"
  mkdir -p "$HERE"
  for f in healthcheck.sh watchdog.sh; do
    fetch "$SCRIPTS_URL/$f" "$HERE/$f" \
      || { echo "could not fetch $f from $SCRIPTS_URL" >&2; exit 1; }
  done
  chmod +x "$HERE"/*.sh
fi
export HF_HOME="$VOLUME/hf-cache"

log() { # level msg [extra-json]
  printf '{"ts":"%s","level":"%s","service":"node","node":"%s","msg":"%s"%s}\n' \
    "$(date -u +%FT%TZ)" "$1" "$NODE_ID" "$2" "${3:+,$3}" | tee -a "$LOG_DIR/bootstrap.log"
  publish_status
}

# The status page: this script's log and, after a failure, the end of
# vLLM's, with the node key taken out. Never the environment.
publish_status() {
  [ -n "${ANCILE_STATUS_PORT:-}" ] || return 0
  {
    tail -n 60 "$LOG_DIR/bootstrap.log" 2>/dev/null
    if [ -s "$LOG_DIR/watchdog.log" ]; then
      echo '--- watchdog.log, last 10 lines'
      tail -n 10 "$LOG_DIR/watchdog.log"
    fi
    if [ -f "$STATE_DIR/failed" ]; then
      echo '--- vllm.log, last 40 lines'
      tail -n 40 "$LOG_DIR/vllm.log" 2>/dev/null
    fi
  } | KEY="$ANCILE_NODE_API_KEY" python3 -c 'import os, sys; sys.stdout.write(sys.stdin.read().replace(os.environ["KEY"], "<node key>"))' \
    > "$STATE_DIR/status/index.txt.tmp" && mv "$STATE_DIR/status/index.txt.tmp" "$STATE_DIR/status/index.txt"
}
if [ -n "${ANCILE_STATUS_PORT:-}" ]; then
  mkdir -p "$STATE_DIR/status"
  : > "$STATE_DIR/status/index.txt"
  (cd "$STATE_DIR/status" && nohup python3 -m http.server "$ANCILE_STATUS_PORT" >/dev/null 2>&1 &)
fi

heartbeat() { # state detail
  [ -n "${CONTROLLER_URL:-}" ] || return 0
  curl -fsS -m 5 -X POST "${CONTROLLER_URL%/}/control/v1/nodes/heartbeat" \
    -H "authorization: Bearer ${CONTROLLER_NODE_TOKEN}" \
    -H 'content-type: application/json' \
    -d "{\"provider_ref\":\"$NODE_ID\",\"state\":\"$1\",\"detail\":\"$2\",\"model\":\"$ANCILE_SERVED_NAME\",\"port\":$ANCILE_PORT}" \
    >/dev/null 2>&1 && date +%s > "$STATE_DIR/last_heartbeat_ok" || true
}

# The health check and heartbeats use curl; slim images may lack it.
if ! command -v curl >/dev/null 2>&1; then
  log info "installing curl"
  { apt-get update -qq && apt-get install -y -qq curl; } >/dev/null 2>&1 \
    || log error "curl is missing and could not be installed; the health check will fail"
fi

# --- 1. vLLM: the image's own, else a pinned one cached on the volume -------
if command -v vllm >/dev/null 2>&1; then
  VLLM="$(command -v vllm)"
  PYBIN="$(dirname "$VLLM")"
  [ -x "$PYBIN/python3" ] || PYBIN="$(dirname "$(command -v python3)")"
  log info "using the image's vllm" "\"version\":\"$("$PYBIN/python3" -c 'import vllm; print(vllm.__version__)' 2>/dev/null || echo unknown)\""
else
  VENV="$VOLUME/venvs/vllm-$ANCILE_VLLM_VERSION"
  VLLM="$VENV/bin/vllm"
  PYBIN="$VENV/bin"
  if [ ! -x "$VLLM" ]; then
    log info "installing vllm $ANCILE_VLLM_VERSION into $VENV"
    heartbeat starting "installing vLLM $ANCILE_VLLM_VERSION"
    command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
    uv venv --python 3.12 "$VENV"
    VIRTUAL_ENV="$VENV" uv pip install "vllm==$ANCILE_VLLM_VERSION" hf_transfer
  else
    log info "vllm $ANCILE_VLLM_VERSION already installed"
  fi
fi
# Faster downloads only when hf_transfer is there: huggingface_hub refuses
# to download at all when asked for it and it is missing.
if "$PYBIN/python3" -c 'import hf_transfer' >/dev/null 2>&1; then export HF_HUB_ENABLE_HF_TRANSFER=1; fi

# --- 2. Weights on the volume (no-op when present) --------------------------
heartbeat starting "fetching weights for $ANCILE_MODEL"
log info "ensuring weights" "\"model\":\"$ANCILE_MODEL\""
# huggingface_hub 1.x names its CLI `hf`; older releases `huggingface-cli`.
HF_CLI="$PYBIN/hf"; [ -x "$HF_CLI" ] || HF_CLI="$PYBIN/huggingface-cli"
[ -x "$HF_CLI" ] || HF_CLI="$(command -v hf || command -v huggingface-cli || echo hf)"
"$HF_CLI" download "$ANCILE_MODEL" >/dev/null 2>>"$LOG_DIR/bootstrap.log" \
  || { touch "$STATE_DIR/failed"; log error "weight download failed; check HF_TOKEN for gated models and volume free space"; heartbeat error "weight download failed"; exit 1; }

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
nohup "$VLLM" serve "$ANCILE_MODEL" \
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
    touch "$STATE_DIR/failed"
    log error "vllm exited during startup; last lines follow in vllm.log"
    tail -n 30 "$LOG_DIR/vllm.log" >&2 || true
    heartbeat error "vLLM exited during startup (often out of GPU memory: lower --max-model-len or use a quantised model)"
    exit 1
  fi
  sleep 5
done

if ! "$HERE/healthcheck.sh" >/dev/null 2>&1; then
  touch "$STATE_DIR/failed"
  log error "not healthy after 15 minutes"
  heartbeat error "not healthy after 15 minutes"
  exit 1
fi

# --- 5. Backup idle watchdog + heartbeat loop --------------------------------
nohup "$HERE/watchdog.sh" >>"$LOG_DIR/watchdog.log" 2>&1 &
echo $! > "$STATE_DIR/watchdog.pid"

while sleep 30; do
  publish_status
  if "$HERE/healthcheck.sh" >/dev/null 2>&1; then
    heartbeat running "serving $ANCILE_SERVED_NAME"
  else
    heartbeat error "health check failing"
  fi
done
