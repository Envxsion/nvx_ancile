# Self-healing

Things fail: providers rate-limit, a GPU node sleeps, a container crashes, the network drops mid-answer. Ancile's job is to recover without you noticing when it can, and to tell you exactly what happened when it can't.

## The primitives

Every external call goes through `packages/resilience` (TypeScript) or `ancile_knowledge/resilience.py` (Python):

| Primitive | Default | What it prevents |
|---|---|---|
| Timeout with a deadline | Each call inherits what's left of the request's budget | Retries overrunning the time you're willing to wait |
| Retry, exponential backoff with full jitter | 250 ms × 2ⁿ, capped at 8 s, 4 attempts, honours `Retry-After` | Giving up on a blip; thundering herds |
| Circuit breaker per target | Opens at 50% failures over ≥ 8 calls in 60 s, or 5 in a row; first probe after 30 s, doubling to 10 min | Hammering something that's down; waiting on it every time |
| Bulkhead | A concurrency cap per target | One slow provider starving the rest |
| Fallback chain | Per task class, `config/routing.yaml` | One provider being a single point of failure |
| Idempotency keys | On every side-effecting call | Doing something twice after a retry |

Breaker state is shared through Postgres, so Core and Knowledge agree about which provider is down.

## What happens for each kind of failure

| Class | Examples | Ancile does |
|---|---|---|
| transient | network error, 5xx, 429, timeout | Retries, then moves down the chain |
| capacity | GPU node waking, queue full | Waits (bounded) or falls back, whichever you chose |
| refusal | provider content filter, or a refusal in the opening of the reply | Falls back immediately |
| context_overflow | "prompt too long" | Compacts the conversation and retries once |
| policy | Controller cost cap, model disabled | Falls back, doesn't retry |
| permanent | bad API key, invalid request | Falls back. Shows one "fix your key" notification with the exact provider. |
| bug | an error in Ancile itself | Fails the step with full context and flags it in diagnostics |

## Fallback you can see

Fallback doesn't interrupt you, but it isn't hidden either. When it happens:
- the message footer reads `answered by GPT-5.5 · Sonnet was unavailable` in muted type
- the "why" panel lists every attempt with its timing and reason
- the trace keeps the full detail

If a stream breaks after some text has arrived, the next model continues from that point. A hairline in the message marks where.

### Example: a provider outage

1. Sonnet returns 529 three times: retried with backoff, then the breaker opens for Anthropic Sonnet.
2. The turn falls back to GPT-5.5 and streams normally. The footer notes the fallback.
3. For the next 30 s, turns skip Sonnet straight away, with no wasted retries.
4. A probe succeeds and the breaker closes. Sonnet answers again.

## When your GPU node is asleep

1. The Controller has the model but its node is stopped. It queues the request and replies `503 node_waking (eta 80 s)`.
2. Ancile shows **Waking your GPU node · about 80 s**, with **Use a cloud model instead** and **Cancel**.
3. When the node passes its health check, queued requests run in order and your answer streams.
4. If the wait passes `compute_wait_max_s` (240 s by default), Ancile falls back down the chain.

If the Controller itself is down, Core holds node-only requests in its outbox and retries. The Health page shows the Controller as down, with a link to its runbook.

## Supervision and automatic restarts

Core probes every dependency every 15 s: Postgres, Knowledge, Controller, each enabled provider, each MCP server, disk space, and the memory repository.

| Setting | Default |
|---|---|
| Restart after consecutive failures | 3 (`ANCILE_RESTART_AFTER_FAILURES`) |
| Restart adapter | `none`. `process` in dev; `docker` is opt-in because it needs the Docker socket |
| Storm protection | At most 3 restarts in 10 minutes. After that the service is marked **needs attention**, with its last error and a link to the runbook. |

Health shows each service's state, consecutive failures, last success, last error and restart history. **Restart** does the same thing by hand, with a confirmation chain.

## Runs survive restarts

Each step of a run (context, memory, retrieval, model call, each tool call) is saved before the next begins. A worker holds a lease on the run and renews it every 10 s. If Core dies:

- On the next boot, the sweeper finds runs whose lease expired and resumes them from their last saved step.
- Saved steps are replayed from their recorded outputs, not executed again.
- A tool call that was in flight with no recorded result is retried with the same idempotency key. If the tool can't honour keys, the step is marked uncertain and you're asked before it runs again.
- Your browser reconnects and replays the stream from the last event it saw.

## Testing it

- `tests/chaos/` breaks things on purpose: provider flaps, a Postgres restart mid-stream, killing Core during a tool loop, the Controller going down, a node flapping, a restart storm.
- In development, the fake provider (`NODE_ENV=test`) lets you script failures:

  ```
  /model fake/fail-500 then hello
  /fake slow 40 words
  /fake refuse
  ```
