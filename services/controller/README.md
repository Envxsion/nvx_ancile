# NVX Ancile Controller

The Controller manages remote compute and routes model traffic to it. It runs alongside Ancile, not inside it. It has its own process, its own Postgres schema (`controller`), its own version, and its own contract. Ancile talks to it only over HTTP, and Ancile works without it (DESIGN.md §1.2).

**Core decides *which* model. The Controller decides *where* it runs.**

| It owns | It does not own |
|---|---|
| Nodes and their lifecycle (start / stop / restart / terminate) | Which model suits a task (Core's router) |
| Confirmation chains for every action | Tool permissions (Core) |
| Route aliases → nodes / upstreams | Memory, retrieval, conversations |
| Queueing while a node wakes | |
| Cost tracking, cost caps, idle and scheduled shutdown | |

## Contract (v1.0.0)

The whole surface is defined in [`packages/contracts/src/controller.ts`](../../packages/contracts/src/controller.ts). Any implementation that passes `pnpm test:contract` (`CONTRACT_BASE_URL=… CONTRACT_TOKEN=…`) can stand in for this one.

Every endpoint except `/health` needs `Authorization: Bearer $CONTROLLER_TOKEN`. Errors use the shared `ApiError` shape: `code`, `title`, `hint`, `trace_id`.

### Health

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness only. No auth. |
| `GET /ready` | Store reachable. The provider is reported, but a provider outage does not make the Controller unready, because it can still queue requests. |
| `GET /selftest` | Every check, each with a fix, for the self-diagnostic panel. |

### Control plane: `/control/v1`

| Endpoint | Purpose |
|---|---|
| `GET /nodes` · `GET /nodes/:id` | `ComputeNode` |
| `POST /nodes/:id/actions` `{action, idempotency_key, reason?}` | Returns `202 {operation_id}`. Same key + same request replays the existing operation. Same key + different request returns `409`. |
| `GET /operations/:id` | `Operation`, with its timeline |
| `GET /operations/:id/stream` | SSE. One `step` event per link of the chain, then `done`. Resumable with `Last-Event-ID`. |
| `GET /events` | SSE: `node.operation`, `node.updated`, `notice` |
| `GET /costs?month=YYYY-MM` | `CostSummary`: hourly rate, hours this month, compute cost, storage cost, projected month cost |
| `GET/POST/DELETE /rules` | `idle_timeout`, `schedule` (cron + time zone), `cost_cap` |
| `GET /routes` · `PUT /routes/:alias` | Route alias → targets |

**The confirmation chain** is `requested → acknowledged → in_progress → confirmed`, or it ends at `failed` / `timed_out`. Each step carries the provider's own words. A failure always carries `{code, provider_message, suggestion}`. If a provider skips a step, the skipped links are filled in as *implied*, so the UI always shows a complete chain.

### Data plane: `/v1` (OpenAI-compatible)

The `model` field is a route alias.

| Situation | Response |
|---|---|
| Node running | Streamed through, with `x-controller-node` set |
| Node stopped or waking | Queued, the node is asked to start, `503 {error:{code:'node_waking', eta_s}}` + `Retry-After` |
| Cost cap reached with `block_routing` | `402 {error:{code:'cost_cap'}}`. Core treats it as a non-retryable fallback trigger. |

## Run

```bash
pnpm --filter @nvx/ancile-controller dev     # tsx watch
pnpm --filter @nvx/ancile-controller test    # unit + contract (in-process, fake provider)
CONTROLLER_PROVIDER=local CONTROLLER_STORE=memory pnpm --filter @nvx/ancile-controller dev   # no RunPod, no DB
```

The environment is documented in the root `.env.example`, under *Controller*.

## Providers

`src/providers/types.ts` defines `ComputeProvider`: `getNode`, `action`, `ping`. The adapters:

- **`runpod`**: REST v2, `POST /v2/pods/{id}/action`. The v1 API is retired on 15 Nov 2026. Error messages are mapped to actionable suggestions such as no capacity, low balance, auth, or volume busy.
- **`local`**: a deterministic fake with scripted failures. Tests, e2e and the contract suite use it.

## Status

| Area | State |
|---|---|
| Confirmation-chain state machine, idempotency, timeouts, prechecks | Implemented and tested |
| Executor (ack → poll → confirm, transient retry, usage intervals) | Implemented and tested |
| Costs, idle/schedule/cost-cap rules, cron with time zones | Implemented and tested |
| RunPod v2 adapter and error mapping | Implemented and checked against RunPod's documented schema; not yet run against a live account. |
| Control plane, SSE streams, contract suite | Implemented |
| `PgStore` (Postgres persistence) | Implemented and the default (`CONTROLLER_STORE=postgres`); `memory` is for tests. |
| Holding a request until its node wakes | Partial: the queue records demand and its deadline; Core re-sends after `Retry-After` rather than the Controller holding the body. |
