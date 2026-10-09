# Remote compute

Ancile can run models on your own GPUs: a RunPod pod today, other providers through the same interface later. The **Controller** (`services/controller`) manages them. It's a separate service, and Ancile works perfectly well without it.

Remote nodes are ephemeral and stateless. Your data, memory and history stay on your machine. Model weights live on a network volume so a node can be stopped, started or replaced without downloading them again.

## Setting up RunPod

1. Create an API key in RunPod with pod read/write scope. Put it in `.env`:
   ```
   RUNPOD_API_KEY=rpa_…
   CONTROLLER_URL=http://localhost:7720
   ```
2. Create a **network volume** in the region you want, for the model weights.
3. Create a pod from any CUDA image with the volume mounted at `/workspace`. Set its start command to the node bootstrap:
   ```bash
   bash -c "curl -fsSL https://raw.githubusercontent.com/Envxsion/nvx_ancile/main/infra/node/bootstrap.sh | bash"
   ```
   Then set these env vars on the pod:
   - `ANCILE_MODEL` (e.g. `Qwen/Qwen3-32B-AWQ`)
   - `ANCILE_NODE_API_KEY` (a random string)
   - `CONTROLLER_NODE_TOKEN` (from your `.env`)
   - `CONTROLLER_URL`, if your Controller is reachable from the internet; otherwise the Controller polls instead
4. In Ancile, open Admin → Compute → **Add node**. Pick the pod and the models it serves, and set the hourly and storage rates if RunPod doesn't report them.
5. Add a model with `via: controller` (Settings → Models does this for you), and put it in a routing chain.

The bootstrap:
- installs and starts vLLM with an OpenAI-compatible API on the pod
- verifies `/v1/models` before reporting ready
- runs a watchdog that stops the pod after a period of idleness, even if Ancile is offline

Ancile uses RunPod's REST **v2** API (`POST /v2/pods/{id}/action`). The v1 API is retired on 15 November 2026.

## Testing against RunPod

`pnpm test:runpod` checks the real API with the key from `.env` (it never prints it):

| Command | What it does | Cost |
|---|---|---|
| `pnpm test:runpod` | The key is accepted, and the pod list reads as v2 | Free |
| `pnpm test:runpod --create` | Creates a pod with vLLM serving a small model, waits for an answer through the RunPod proxy, stops it, starts it again, gets a second answer, then terminates it | A few US cents |
| `pnpm test:runpod --create --bootstrap` | The same, but the pod runs `infra/node/bootstrap.sh` from this repo's `main` branch (the setup above), and then waits for the watchdog to stop the idle pod by itself with no Controller in reach | A few US cents |

Options: `--gpu "NVIDIA RTX A4000"`, `--secure` (community cloud by default), `--region EU-RO-1`, `--model Qwen/Qwen2.5-0.5B-Instruct`, `--max-usd-hour 0.40`, `--max-minutes 30` (50 with `--bootstrap`, which also gives the pod a 20 GB volume so the restart reuses vLLM and the weights). The pod it creates is terminated whatever happens: on success, on a failure, on Ctrl+C, and at the time cap. A pod over the price cap is terminated as soon as its price is known. With `--keep` it is stopped instead, so you can add it in Admin → Compute; terminate it in RunPod yourself when you are done.

## Starting and stopping, with a confirmation chain

Every action shows its progress as a four-link chain in the UI, not just in the logs:

```
Requested ──── Acknowledged ──── In progress ──── Confirmed
 03:12:04       03:12:05          03:12:06         03:13:31
                RunPod accepted    Pulling image,   vLLM answered /v1/models
                the start          loading weights
```

Each link lights as it happens, with the provider's own words underneath.
- **Confirmed** means verified: a start is confirmed only when the model server answers, and a stop only when RunPod reports the pod exited.
- **On failure**, the failing link turns red and shows the exact provider message and a suggested fix:

  > **Failed at Acknowledged.** RunPod: "There are no longer any instances available with the requested specifications."
  > Try another region with your network volume's datacentre, or a different GPU type. Your volume and weights are untouched.

- **Terminate** is always critical and asks every time, because it destroys the pod's container disk. The network volume survives.

## Costs

Admin → Compute shows, per node and in total:

| Figure | How it's worked out |
|---|---|
| Hourly rate | From RunPod's `cost` field, or the rate you set |
| Hours this month | Sum of running intervals in `usage_intervals` |
| Compute cost to date | Hours × rate, per interval, so price changes are respected |
| Storage cost | Volume size × the monthly storage rate, prorated |
| Projected month | Cost to date + (average daily running hours × days left × rate) + full-month storage |

A stopped pod still costs storage. Ancile shows that separately so it isn't a surprise.

## Rules

| Rule | Example | What happens |
|---|---|---|
| Idle timeout | Stop after 20 minutes with no requests | The Controller stops the node and you're notified. The in-pod watchdog is the backup. |
| Schedule | Stop every node at 19:00 on weekdays | Cron in your time zone |
| Cost cap | $150 a month: stop nodes / block routing / notify only | At the cap, routing returns `402 cost_cap`, and Ancile falls back to cloud models |

Rules run in the Controller, so they still apply when the Cockpit is closed.

## Requests while a node sleeps

When a request needs a model that's only on a stopped node:
1. The Controller queues it, starts the node, and answers `503 node_waking` with an estimate.
2. Ancile shows "Waking your GPU node · about 90 s" and offers a cloud model instead.

Queued requests run in order once the node is healthy. Any that pass their deadline (`CONTROLLER_QUEUE_DEADLINE_S`) fall back. See [self-healing](self-healing.md#when-your-gpu-node-is-asleep).

## Creating a node

A provider that can create machines implements the optional `create(spec)`, and the Controller then accepts `POST /control/v1/nodes/create` with `{name, spec, idempotency_key, served_models?}`. `spec` names the GPU type and count, an image or a template, the region, secure or community cloud, disk and volume sizes, ports and environment (`CreateNodeSpec` in `packages/contracts/src/controller.ts`). The new node goes through the same four-link chain as a start (requested, acknowledged when the provider has created it, in progress, confirmed once it runs), and the same idempotency key never creates a second machine. RunPod creates pods with `POST /v2/pods`; the local-network provider cannot create and answers 501 (`provider.cannot_create`). Creating pods from the app, with the price shown first, is part of GPU fleet in NVX Ancile Pro; the free edition manages one node you add by its id.

## Using a different provider

Implement `ComputeProvider` in `services/controller/src/providers/` (`getNode`, `action`, `ping`, optionally `create`, and errors as `ProviderError` → `{code, provider_message, suggestion}`). The operation state machine, queue, rules and the UI work unchanged. The conformance suite in `services/controller/test/contract` checks the result.

If a node won't start, see [the runbook](runbooks/node-wont-start.md).
