# Chaos suite (Phase 6)

This suite proves the self-healing claims in DESIGN.md §7 against the real stack, with failures injected on purpose. Each scenario asserts three things: no lost messages, no duplicated tool side effects, and an explanation in the UI for every failure.

| Scenario (`chaos.spec.ts`) | Injection | Expected |
|---|---|---|
| A provider 500 falls back | The offline model's `/fail` directive | The answer completes on the fallback model, and its footer says which model stood in. |
| A provider timeout falls back | `/slow` past the timeout | The same fallback, explained the same way. |
| Ten flaky answers at once | Ten `/fail` turns in parallel | All ten finish, each exactly once. |
| Postgres restarts mid-answer | Core's restart endpoint restarts Postgres | The run resumes from its checkpoint and finishes once; the stream replays without duplicates. |
| Core restarts mid-answer | Touching `main.ts` restarts Core under its file watcher | The sweeper reclaims the lease and the run finishes once. |
| The Controller goes down | Core's restart endpoint stops the Controller | Health says the Controller is down with a fix, then shows it back. |

Run it with `pnpm test:chaos` against the test profile (`pnpm start:e2e`).

Scope (agreed 2026-10-10): beyond these, chaos coverage is limited to the Controller, RunPod and the sync client. Node flapping is covered by the Controller's own tests and the live RunPod shakedown (`pnpm test:runpod`).
