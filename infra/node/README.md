# Remote node (RunPod)

A node is **ephemeral and stateless**. It serves models over an OpenAI-compatible API, and nothing else. Your data, memory and history never leave your machine. Only prompts go to the node, and only when you route to it. Model weights are cached on a network volume, so a restart doesn't re-download them.

| File | Role |
|---|---|
| `bootstrap.sh` | Pod start command. It's idempotent and does these steps in order: (1) uses the image's vLLM, or installs a pinned one on the volume when the image has none; (2) fetches the weights; (3) runs `vllm serve` with an API key; (4) waits on `/v1/models`; (5) heartbeats to the Controller. |
| `healthcheck.sh` | Checks `/v1/models` and confirms the expected model is listed. |
| `watchdog.sh` | Backup auto-stop. It acts only when the Controller has been unreachable for 10 minutes *and* the node has been idle for `ANCILE_IDLE_MINUTES`. It stops the pod and never terminates it. |

## Pod template

- **Image:** `vllm/vllm-openai:v0.11.0`, with the start command as its **entrypoint** (pods created from the app are set up this way). Its vLLM already matches the image's CUDA, so nothing is installed. Any other CUDA 12 image with Python works too, as a start command; the script then installs vLLM on the volume once.
- **Network volume** mounted at `/workspace`, about 2× the model size.
- **Expose HTTP port** `8000`. The Controller reaches it at `https://{podId}-8000.proxy.runpod.net/v1`.
- **Start command:** `bash -c "(curl -fsSL https://raw.githubusercontent.com/Envxsion/nvx_ancile/main/infra/node/bootstrap.sh || python3 -c …) | bash"` (Admin → Compute → *Setting the pod up yourself?* shows it in full, ready to copy). Python stands in when the image has no curl. Piped in like this, the script fetches `healthcheck.sh` and `watchdog.sh` to `/workspace/ancile-node/` itself. Alternatively, copy `infra/node/` to the volume and run `bash /workspace/ancile-node/bootstrap.sh`.
- **Environment:** `ANCILE_MODEL`, `ANCILE_NODE_API_KEY`. Optionally `ANCILE_TOOL_PARSER`, `ANCILE_VLLM_ARGS`, `ANCILE_IDLE_MINUTES`, `ANCILE_STATUS_PORT` (a plain-text page of the setup log, node key removed, on that port; expose it as HTTP to read it through the RunPod proxy), `CONTROLLER_URL`, `CONTROLLER_NODE_TOKEN`, `HF_TOKEN`.

`ANCILE_NODE_API_KEY` must equal the Controller's `CONTROLLER_NODE_TOKEN`: the Controller sends that value as the bearer token on every request it routes to the node, and vLLM rejects any other. Set `CONTROLLER_NODE_TOKEN` on the pod to the same value so heartbeats are accepted. A pod created from the app gets the value from the Controller itself; only a pod you set up by hand needs it typed in.

## Notes and open items

- Heartbeats (`POST /control/v1/nodes/heartbeat`, authenticated with `CONTROLLER_NODE_TOKEN`, never the Controller's own token) put the node's progress on the confirmation chain ("fetching weights", "loading into GPU memory") and register the served model as soon as it is up. Without them the Controller still polls the provider API every 30 s.
- The watchdog treats a missing heartbeat as "Controller unreachable" by design. If you run nodes without a Controller, it becomes the only auto-stop.
- The pinned vLLM version (`0.11.0`) is a default. Check the current release and model support before production use.

## vLLM defaults

`vllm-defaults.sh` adds, unless `ANCILE_VLLM_ARGS` already sets them: `--enable-prompt-tokens-details` (cached prompt tokens are reported in usage), and on a GPU with 12 GB or less `--gpu-memory-utilization 0.85` (0.80 at 10 GB or less) and `--enforce-eager`. After a failed start the status page shows vLLM's first error lines and its last 80 lines.
