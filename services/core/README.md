# @nvx/ancile-core

Core sits between the Cockpit, the Knowledge service, the Controller and the model providers. It assembles context and injects memory. It also routes every model call with fallback, enforces permissions, runs durable agent runs, and records everything for the "why did the AI say this?" view. See `DESIGN.md` §1–§11.

## Run

```bash
pnpm --filter @nvx/ancile-core dev        # hot reload, reads ../../.env
pnpm --filter @nvx/ancile-core test       # unit suite (no database needed)
pnpm --filter @nvx/ancile-core test:boot  # the fast boot suite
pnpm --filter @nvx/ancile-core db:migrate # apply src/db/migrations/*.sql
```

In normal use, `pnpm start` at the repository root runs the boot suite first and only starts Core if it passes.

## Layout

| Path | What it does | State |
|---|---|---|
| `src/env.ts` | Validates the environment once and names the wrong variable | built |
| `src/obs/` | JSON logs with trace ids, OTel tracing, the single error shape, redaction | built (span store: phase 5) |
| `src/db/` | Drizzle schema for `core.*`, SQL migrations, migrator | built |
| `src/permissions/` | Normalisation, globs, pattern suggestions, `decide()` | **built and tested** (Cedar loading: phase 2) |
| `src/memory/format.ts` | Memory markdown parse/render with byte-exact round trip; add, update and supersede | **built and tested** |
| `src/memory/inject.ts` | Budgeted memory pack by whole entries | **built and tested** |
| `src/memory/capture.ts` | Apply policy, including the anti-poisoning rule | policy built; detectors in phase 4 |
| `src/threads/path.ts` | Ancestor paths, compaction reuse, LCA, collapsed tree, branch snapping | **built and tested** |
| `src/runs/` | Run state machine, event log with replay-then-tail, engine interfaces | machine and log built; Postgres store in phase 2 |
| `src/gateway/` | Chain resolution, refusal detection, streaming fallback with seams, AI SDK client | **built and tested** against the fake provider |
| `src/factcheck/` | Confidence formula with a plain-language explanation; pipeline interfaces | score built; steps in phase 4 |
| `src/health/` | Supervisor policy (threshold, storm protection), probes, restart adapters | policy built; adapters in phase 5 |
| `src/http/stubs.ts` | Every planned route answers 501 with the phase that delivers it | |
| `src/secrets.ts`, `src/license/` | AES-256-GCM secret box; Ed25519 licence tokens | built and tested |

## Boot test convention

Boot tests live in `test/boot/*.boot.test.ts` and declare each check with `bootCheck(what, fix, fn)`. That produces a test named:

```
<what> | fix: <remediation>
```

`scripts/boot.mjs` runs `vitest run --project boot --reporter=json` with `ANCILE_BOOT_CONTEXT=boot`. For each failed test it splits the full name on ` | fix: ` and prints:

```
✗ Postgres answers
  Why:  connect ECONNREFUSED 127.0.0.1:5433
  Fix:  Start it with `docker compose up -d postgres` and check DATABASE_URL in .env.
```

Under `ANCILE_BOOT_CONTEXT=boot`, database checks are mandatory. In CI without a database they are skipped, and the skip is reported.

## Writing a route

1. Delete its row from `src/http/stubs.ts`.
2. Validate input with a schema from `@nvx/contracts`.
3. Throw `AncileError` with a plain `title` and an actionable `hint`. Never return a raw error.
4. Add a contract test.
