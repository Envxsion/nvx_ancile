# Testing

| Command | What it runs | Cost |
|---|---|---|
| `pnpm test` | Unit tests (TypeScript and Python) | Free |
| `pnpm test:boot` | Each service's boot suite | Free |
| `pnpm start:e2e` then `pnpm test:e2e` | Browser journeys against the test profile, offline models only | Free |
| `pnpm test:runpod` | The RunPod adapter against the real API ([compute.md](compute.md)) | Free, or a few US cents with `--create` |
| `pnpm test:live --dry` | The live spec against the test profile, with offline models | Free |
| `pnpm test:live --yes` | The live suite below, with real models | Under $2, hard-capped |

Every test that calls Core's HTTP API carries credentials, because Core answers only its owner ([api.md](api.md#calling-the-api)). Core's own tests build the app with a known install key, which is a required argument of `createApp`. Their `call` helper acts as a paired browser (cookie and `Origin`), and `callAs` sends anything else: a script with the key, a stranger, a foreign origin. What is refused is proved in `services/core/test/http/local-auth.test.ts`. The browser suites read the profile's key from its data folder, and `pnpm test:live` and `pnpm seed` hand their children the key's file, never its value.

## The live suite (LT1)

Offline fakes cannot show what real providers do. The live suite moves one chat between Claude Haiku and a small open model on a RunPod pod, and back, then checks four things:

1. **Context carries across models.** Fact A is given to Haiku. The pod model (`Qwen/Qwen2.5-1.5B-Instruct` on vLLM) is asked for it. Fact B goes to the pod model and Haiku is asked for that.
2. **Haiku's prompt cache is read after switching back.** Turn 1 sends a long stable prefix of about 8,000 tokens. Haiku 4.5 caches nothing shorter than 4,096 tokens ([Anthropic, prompt caching, "Cache limitations"](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)), so the prefix is padded to roughly twice that. Turns 3 and 4 must show `cached_tokens > 0` on the receipt, and `GET /threads/:id/cache-state` must agree (a warm mark, `reported: true`).
3. **Receipts name the right payer.** Haiku: billing `key` with payer `anthropic`, or `credit` when the key is marked as the plan's monthly API credit. The pod: `rented`. The model that answered must be the one asked for, with no fallback.
4. **The pod is stopped at the end.** Whatever happens, a `finally` terminates the node and the run fails loudly if it cannot confirm it. The Controller's idle stop is also set to 30 minutes for the node as a backstop.

The spec is `tests/live/live.spec.ts`. It talks to Core's HTTP API with Playwright's `request` (the e2e suite already uses Playwright, so there is one toolchain, traces on failure and optional screenshots with `--shots`). It runs in a notebook called "Live tests (safe to delete)", which it moves to the Trash at the end. It never retries: a retry would spend money twice.

### What it costs

- **The model calls** are capped at **$2 per run**. Haiku is cheap: four short answers, one about 8,000-token prefix written once and read after, come to well under a cent or two. The cap is a hard limit, not a forecast.
- **The pod** is billed by RunPod at its hourly rate. The cheapest listed GPU is chosen (RTX A4000 class), and the run refuses a node over $0.60 an hour. It lives for the time it takes to load (up to 10 minutes) plus the four turns, so expect a few US cents.

### The cap and the guard

`pnpm test:live` starts Core with two variables:

- `ANCILE_LIVE_ALLOW`: a comma list of model ids, for example `anthropic/claude-haiku-4-5,node/qwen2.5-1.5b`. Core refuses every other model before anything is sent, with `e2e.real_model_blocked`. The offline models are always allowed. Claude Code is refused in both modes (the bridge never launches and the CLI is never found), as are the calls that bypass the gateway (image providers and the Jev reviewers). Background work that calls models (titles, memory, fact-check, auto-review, flows) goes through the same gateway, so it can only use the listed models and skips when refused.
- `ANCILE_LIVE_CAP_USD` (default 2): Core keeps a running total of what every call billed (`billed_usd`, else `cost_usd`) in that process. Before each call it refuses with `live.cap_reached` once the total, the calls still running and an estimate of the next call would pass the cap ([errors.md](errors.md)).

A model asked for by name answers alone in a live run: the chain behind it is dropped, so a failure fails the turn instead of moving the call to another model.

With neither variable set, nothing changes.

### Before you run it

1. Add an **Anthropic key** in **Settings → Keys → Anthropic**. If it comes from the Claude Console organisation that holds your Max or Team plan's monthly API credit, mark it as monthly credit there; the receipts then expect `credit`.
2. Add a **RunPod key** in **Admin → Compute → Connect RunPod** (read and write on pods).
3. Close anything you are doing in NVX Ancile: the runner stops your everyday stack.

### Running it

```
pnpm test:live            # says what it will do, and stops
pnpm test:live --yes      # the real run
pnpm test:live --dry      # free rehearsal on the test profile
```

Options: `--haiku <model id>`, `--cap <usd>`, `--shots`.

The runner checks both keys through `GET /api/v1/credentials`, which only says `set: true` or `false` and never shows a value. If a key is missing it refuses, before stopping anything. Then it runs `pnpm stop`, starts the stack with the live guard on your everyday ports (7700 and 7701), runs the spec, and always stops the stack it started. Start NVX Ancile normally afterwards with `pnpm start`. Its log is `.ancile/logs/test-live.log`.

### The dry run

`pnpm test:live --dry` runs the same spec against the test profile (`pnpm start:e2e`, ports 7800 and 7801) with `offline/test` standing in for both models and the Controller's sample provider standing in for RunPod. Cache assertions only check "reported or not reported", and the context check is skipped, because the offline model cannot prove either. It starts the test profile if it is not running, checks that the log says "Claude Code is off", and stops it afterwards.

## Recorded provider replies (fact-check web routes)

The parsers for the three fact-check web routes (`services/core/src/factcheck/web-models.ts`) are tested against real, redacted replies in `services/core/test/fixtures/web/<route>.json`. Tests replay them and never touch the network.

To refresh them, with the everyday stack running:

1. `POST /api/v1/diagnostics/web-record` arms the next web lookup of each route. It lives in memory only, expires after 10 minutes and keeps one reply per route. Nothing is recorded unless you arm it.
2. Run one fact-check with the web on. A route that is resting or has no key is skipped, so its file is simply missing.
3. `GET /api/v1/diagnostics/web-record` lists what was written, in `<data dir>/diagnostics/web/`.
4. Read each file. The key, call ids and encrypted blobs are masked and headers are never kept, but check anyway. Then copy the files to `services/core/test/fixtures/web/`.
