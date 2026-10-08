# Runbook: a GPU node won't start

**You see:** the confirmation chain stops with a red link, and the error names the provider's message and a suggested fix. Start there. The table below covers the rest.

## Which link failed

| Failed at | Meaning |
|---|---|
| **Requested** | Ancile couldn't reach the Controller, or the Controller refused the request (cost cap, invalid state) |
| **Acknowledged** | RunPod refused the action |
| **In progress** | RunPod accepted, but the pod never reached running, or the bootstrap failed |
| **Confirmed** | The pod runs, but the model server never answered `/v1/models` |

## Causes and fixes

| Message | Fix |
|---|---|
| "no longer any instances available" | No capacity for that GPU in that region. Try another GPU type in the same datacentre as your network volume. A volume can only attach in its own datacentre. |
| `409` "cannot start pod in state …" | It's already starting or stopping. Wait for the current operation; the chain shows it. |
| `cost_cap` | This month's cap is reached. Raise it in Admin → Compute → Rules, or use cloud models. |
| `401` / `403` | `RUNPOD_API_KEY` is wrong or lacks pod write scope. |
| Stuck at In progress for more than 10 minutes | Open the pod's logs in RunPod. If you see `CUDA out of memory`, the model doesn't fit: choose a quantised build (AWQ/GPTQ) or a bigger GPU. If you see `No space left`, increase the volume. |
| Confirmed never lights; the pod runs | The bootstrap failed. On the pod: `cat /workspace/ancile-node/bootstrap.log`. Usually a typo in `ANCILE_NODE_MODEL` or a gated Hugging Face model without `HF_TOKEN`. |
| Heartbeats missing | `CONTROLLER_NODE_TOKEN` differs between the pod and `.env`, or the pod can't reach `CONTROLLER_HEARTBEAT_URL`. Without a public URL, leave it empty and the Controller polls the pod instead. |

## Checks from your machine

```bash
# Is the Controller up?
curl -s localhost:7720/ready
# What does it think the node is doing?
curl -s -H "Authorization: Bearer $CONTROLLER_TOKEN" localhost:7720/control/v1/nodes | jq
# The last operation and its timeline
curl -s -H "Authorization: Bearer $CONTROLLER_TOKEN" localhost:7720/control/v1/operations/<opn_id> | jq .timeline
```

## Meanwhile

Requests for node models wait (up to `CONTROLLER_QUEUE_DEADLINE_S`), then fall back to cloud models if your routing chain has them. Nothing is lost.
