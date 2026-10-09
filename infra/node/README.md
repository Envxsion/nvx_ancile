# Remote node (RunPod)

A node is **ephemeral and stateless**. It serves models over an OpenAI-compatible API, and nothing else. Your data, memory and history never leave your machine. Only prompts go to the node, and only when you route to it. Model weights are cached on a network volume, so a restart doesn't re-download them.

| File | Role |
|---|---|
| `bootstrap.sh` | Pod start command. It's idempotent and does these steps in order: (1) installs a pinned vLLM on the volume; (2) fetches the weights; (3) runs `vllm serve` with an API key; (4) waits on `/v1/models`; (5) heartbeats to the Controller. |
| `healthcheck.sh` | Checks `/v1/models` and confirms the expected model is listed. |
| `watchdog.sh` | Backup auto-stop. It acts only when the Controller has been unreachable for 10 minutes *and* the node has been idle for `ANCILE_IDLE_MINUTES`. It stops the pod and never terminates it. |

## Pod template

- **Image:** any CUDA 12 image with Python and curl, e.g. `runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04`.
- **Network volume** mounted at `/workspace`, about 2× the model size.
- **Expose HTTP port** `8000`. The Controller reaches it at `https://{podId}-8000.proxy.runpod.net/v1`.
- **Start command:** `bash -c "curl -fsSL https://raw.githubusercontent.com/Envxsion/nvx_ancile/main/infra/node/bootstrap.sh | bash"`. Piped in like this, the script fetches `healthcheck.sh` and `watchdog.sh` to `/workspace/ancile-node/` itself. Alternatively, copy `infra/node/` to the volume and run `bash /workspace/ancile-node/bootstrap.sh`.
- **Environment:** `ANCILE_MODEL`, `ANCILE_NODE_API_KEY`. Optionally `ANCILE_TOOL_PARSER`, `ANCILE_VLLM_ARGS`, `CONTROLLER_URL`, `CONTROLLER_NODE_TOKEN`, `HF_TOKEN`.

Set the same `ANCILE_NODE_API_KEY` as the node's token in the Controller, so the data plane can authenticate to vLLM.

## Notes and open items

- Heartbeats (`POST /control/v1/nodes/heartbeat`, authenticated with `CONTROLLER_NODE_TOKEN`, never the Controller's own token) put the node's progress on the confirmation chain ("fetching weights", "loading into GPU memory") and register the served model as soon as it is up. Without them the Controller still polls the provider API every 30 s.
- The watchdog treats a missing heartbeat as "Controller unreachable" by design. If you run nodes without a Controller, it becomes the only auto-stop.
- The pinned vLLM version (`0.11.0`) is a default. Check the current release and model support before production use.
