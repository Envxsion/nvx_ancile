# Decision models

A decision model reads a short state and answers typed questions with probabilities, not prose. NVX Ancile uses them for the quick judgements around a chat: Auto mode's reviewer, flow routers, the fact-check gate's triage, Keystone's intent and automations. One interface serves them all (`packages/contracts/src/decisions.ts`, `services/core/src/decisions/`), so a caller never knows or cares which provider answered.

Why: they cost a few millionths of a dollar a call, answer in tens of milliseconds, and give a calibrated probability a threshold can act on. Several have a free daily allowance, which this layer counts and uses first.

## The interface

```ts
router.decide(task, { state, questions }, { notebookId?, private?, only?, signal? })
  → { ok: true, answers, receipt, tried } | { ok: false, note, tried }
```

- **Questions** (1 to 64): `noul` (yes/no, answers a probability), `choice` (options with descriptions, answers the best option and a probability for each), `score` (ordered levels, answers a position and a probability for each), `box` (locate something in an image; Jev 1.14 only, answer passed through).
- **Tasks:** `auto_review`, `flow_router`, `flow_condition`, `factcheck_triage`, `keystone_intent`, `automation`. Each has a profile (`catalogue.ts`): `auto_review` is **reasoning** and prefers Clef or Jev; the rest are **fast sorting** and prefer Clef-flash or a flash decider.
- **Never blocks a turn.** When no decision model can answer, `decide` returns `{ ok: false, note }`. The caller keeps what it did before (the chat model for a router, the rules for Auto mode, the most careful tier for triage) and may show the quiet note.

## Providers

All read on 2026-10-20. "Verified" means the provider's own page showed the endpoint, the auth and the price; the request body is the Jev shape throughout.

| Route | Endpoint | Auth | Price (input, per million) | Free tier | Source | Verified |
|---|---|---|---|---|---|---|
| `cf_clef_flash` | `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/cloudflare/clef-flash` | Bearer API token (Workers AI template: Workers AI Read and Edit) | $0.038; 3,455 neurons; context 24,576 | 10,000 neurons a day, reset 00:00 UTC | developers.cloudflare.com/workers-ai/models/clef-flash/, /platform/pricing/ | Yes |
| `cf_clef` | the same, `.../clef` | the same | $0.24; 21,818 neurons; context 65,536 | the same allowance | developers.cloudflare.com/workers-ai/models/clef/ | Yes |
| `jev_openrouter` | `POST https://openrouter.ai/api/alpha/decisions`, model `~typesafe/jev-latest`, then `typesafe/jev-1.13` | OpenRouter key | $0.042; cost reported on each answer | none | openrouter.ai/docs/guides/community/jev | Yes |
| `jev_direct` | `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest` | TypeSafe key | $0.042 | none | docs.typesafe.ai/api | Yes |
| `pplx_flash` | `POST https://api.perplexity.ai/v1/decisions`, model `pplx-decider-flash-latest` (4B) | Perplexity key | $0.01 | none documented | docs.perplexity.ai/docs/decisions/quickstart | Yes |
| `pplx_decider` | the same, model `pplx-decider-latest` (27B) | the same | $0.02 | none documented | the same | Yes |
| `or_pplx_flash` | OpenRouter decisions, `perplexity/pplx-decider-flash-v1.2` | OpenRouter key | about $0.01 (reported per answer) | none | openrouter.ai/docs/guides/community/jev | Yes (model listed) |
| `or_clef_flash` | OpenRouter decisions, `cloudflare/clef-flash` | OpenRouter key | about $0.038 (reported per answer) | none | the same | Yes (model listed) |
| `local_jev` | `POST {your address}/v1/systemone` | none, or an optional key | free | unlimited | huggingface.co/Cloudflare/clef-flash (vLLM and SGLang); the laya-serve project | Yes for Clef-flash; Laya by its project page |
| `openai_luna` | `POST https://api.openai.com/v1/decisions`, model `gpt-6-luna` | OpenAI key | not published (Luna's standard $0.10 is the only figure) | none | news coverage (thenewstack.io); OpenAI's own pages were not readable | **No.** Off by default. A key without access gets 403 "Decision API is not enabled for this user"; the route rests for an hour and the Settings row says so in those words. |

Output is free on every route and none offers provider-side prompt caching. A receipt (`DecisionReceipt`) therefore has input tokens, output tokens (informational), a cost with its basis (`reported`, `listed` or `free`) and the allowance units used, and **no cache field**. Nothing in the product claims a cache saving for a decision.

### What does not exist, or is not added

- **"Julia"** as a hosted API: none found. **Julia-1** (Supersonic Labs, 144M parameters, Apache 2.0, CPU) is an open model. If you serve it behind a Jev-compatible `/v1/systemone` server, the local address field takes it; no separate adapter.
- **Laya** (ConvAI Innovations, 421M, ModernBERT, Apache 2.0, English, context 512) has no priced hosted API. It is a local option through `laya-serve` (CPU, port 8080).
- **OpenRouter also lists** Microsoft, Inception, Liquid AI and Upstage decision models (22 models from 13 providers on 2026-10-20). They are not added yet: the model pages for their request quirks were not read, and some use non-standard state shapes. TODO(phase-5b): per-model adapters.
- **Solar Decide, Kev, Mercury Decide, Tev1, Span, Liquid d1:** no public API pages found, not added.

## Free first, then cheapest

For each `decide` the router:

1. **Privacy.** `privacy.resolve('decisions_off_machine', …)` (docs/privacy.md). Not private: every route is open. Private: a decision server on this machine or your own GPU node is the default and goes first; hosted routes only when Settings → Private notebooks allows them. With neither, `decide` returns the note.
2. **Candidates.** A route is a candidate when it is switched on, connected (a key, or for Cloudflare a token and an account ID), not resting, within its context, inside its caps, and (Cloudflare) the request fits under the allowance ceiling.
3. **Order** (with "Use free allowances first" on, the default): free routes that suit the task, then the cheapest paid route that suits, then free routes that suit less, then paid ones that suit less. Among free routes the one with the most allowance left goes first, so providers rotate. With the switch off, the cheapest route that suits comes first. Ties fall to the order in Settings → Decisions (Pro can set a per-task order through the `taskOrder` hook).
4. **Try in turn.** A 402 (out of credit) rests that provider for 15 minutes and moves on, so OpenRouter running dry moves to TypeSafe. A refused key rests for 10 minutes; a "not enabled" refusal for an hour. A model name the service does not know (400, 404, 422) tries the route's next name. An outage or timeout goes to the next route; the circuit breaker (packages/resilience) stops hammering a service that is down.

### Counting the free allowance

Cloudflare bills Workers AI in neurons. The router counts **tokens times neurons per million tokens** (3,455 for Clef-flash, 21,818 for Clef) from the `usage` the service reports; when it reports none, the router counts about four characters to a token plus 15%. Before every call it checks that the used count plus that call's estimate stays at or under the **ceiling**, default **9,950** (a 50-neuron margin you can change in `ceilings`). Past it, the Cloudflare routes are not candidates until **00:00 UTC** (11 am AEDT), when the counter, kept for the UTC day in `core.settings` (`free.counters`), resets. A provider saying the daily allowance is gone (Cloudflare error 4006) sets the counter to the limit at once. Cloudflare past the free line would bill $0.011 per 1,000 neurons; this layer never takes that step.

The counters live in `services/core/src/free/allowances.ts`, written for the free mode (FR2) to reuse: an `AllowanceDef` (limit, default ceiling, source) per provider and one `Counters` table of named daily counters.

### Caps

Spend caps are per UTC day, per provider, route or model (`caps` in the settings). A provider with no cap has $1 a day (`DEFAULT_PROVIDER_CAP_USD`). Local routes have none. A paid call's cost is the figure the service reports, else tokens times the listed price; when the cap would be passed, the route is skipped.

## Callers

- **Auto mode** (`permissions/auto/decision-reviewer.ts`): two reviewers, `decisions` (hosted) and `decisions_local`, ask the same two `noul` questions as before (`fits`, `injection`). Hosted decision reviewers are still never asked in a private notebook (a locked floor); the local one is. Behaviour, thresholds and the evals are unchanged. `JevReviewer` remains for the live eval script (`pnpm --filter @nvx/ancile-core eval:auto`).
- **Flow routers** (`decider: 'decision'` on a router node, Pick with in the node panel): one `choice` question over the route labels. A confident answer (at or above the node's minimum confidence) picks the route and the decision log says "Chosen by a decision model"; otherwise the router's chat model decides, as before. Rule nodes stay deterministic.
- **Fact-check triage** (`decisionTriage(router)` in `decisions/ask.ts`): implements `classify(claims[]) → tiers` with one `choice` question per claim (batches of 64). The tiers default to `none`, `quick`, `deep`; pass your own. A claim it cannot place gets the most careful tier, so a miss never skips a check. Wire it as the triage provider: `setTriageProvider(decisionTriage(decisions, { tiers }))`.
- **Keystone intent and automations** use the same `decide` call with their task id (TODO(phase-5b): wire when those modules take a decider).

## Keys

Settings → API keys → **Decision models**: **Cloudflare Workers AI** (an API token from the Workers AI template and the account ID from Workers AI → Use REST API) and **TypeSafe**. The Cloudflare key is checked with Cloudflare's token verify call, `GET /accounts/{id}/tokens/verify` and then `GET /user/tokens/verify` (the user form is on the create-token page; the account form comes from Cloudflare's API reference and was not re-read), which spends no neurons. OpenRouter, Perplexity and OpenAI use the keys already saved for their models. A saved Cloudflare token also lights up Cloudflare chat models in Admin → Models.

## On your own hardware

The local route needs a server that speaks the Jev API at `POST /v1/systemone`:

- **Clef-flash** (`Cloudflare/clef-flash`, Qwen3.5-9B base, Apache 2.0): `vllm serve "Cloudflare/clef-flash"` or the SGLang image from the model card, on a GPU. Point it at the computer or at your own RunPod node.
- **Laya** through `laya-serve` on a CPU (about 2 to 4 GB).
- **Ollama cannot serve these.** It returns text, not the typed probabilities a decision needs, and a prompt-and-parse stand-in would lose the calibration that makes the answers useful. For a chat model on Ollama, Auto mode's separate `local_model` reviewer remains (strict JSON prompt).

Set the address in Settings → Decisions → On this computer. A server there counts as private. Pointing it at a service you do not run defeats that; Core cannot tell. The router probes `GET /v1/models` (cached 30 seconds) before using it.

## Settings → Decisions

One switch (**Use free allowances first**, on), a meter per allowance (used of ceiling, the reset time), the routes with their state in words and an on/off switch and Up/Down for the order, the local server address, and a daily cap per paid provider. Per-task model choice and side-by-side scoring are Pro (Flow lab); the Free build keeps one order.

## Errors

`decisions.local_url_invalid` (docs/errors.md). Provider problems never reach a user as errors: they become a resting route and a line in the Settings row, in the provider's own words where it gave them.
