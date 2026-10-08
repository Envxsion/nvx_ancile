# Chaos suite (Phase 6)

This suite proves the self-healing claims in DESIGN.md §7 against the real stack, with failures injected on purpose. Each scenario asserts three things: no lost messages, no duplicated tool side effects, and an explanation in the UI for every failure.

| Scenario | Injection | Expected |
|---|---|---|
| `provider-flap.spec.ts` | Fake provider returns 500 or times out on 30% of calls | Answers complete through retries and fallback. The breaker opens and recovers. The footer notes each fallback. |
| `db-restart.spec.ts` | `docker compose restart postgres` mid-stream | Runs resume from their checkpoint, streams reconnect and replay, and nothing is duplicated. |
| `core-kill.spec.ts` | SIGKILL Core during a tool loop | The sweeper reclaims the lease, the run resumes, and the idempotent tool runs once. A non-idempotent tool is marked uncertain and asks. |
| `controller-down.spec.ts` | Stop the Controller | Node-only requests wait in the outbox, cloud fallback is offered, and health shows the Controller down with a fix. |
| `node-flap.spec.ts` | The fake node alternates healthy and unhealthy | Requests queue during the outage and complete when the node recovers. Queued requests past their deadline expire, and Core falls back. |
| `restart-storm.spec.ts` | Knowledge crashes on boot repeatedly | 3 restarts in 10 minutes, then "needs attention" with the last error. |

TODO(phase-6): implement the scenarios in Playwright, driving fault injection through Core's test-only `/api/v1/__test/*` endpoints (enabled only when `NODE_ENV=test`).
