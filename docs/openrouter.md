# OpenRouter in NVX Ancile

OpenRouter serves each model through several providers. By default it spreads requests among them by price (inverse-square weighting on price, after preferring stable providers), so "the same model" can answer from different computers run by different companies. NVX Ancile shows those providers, lets you choose how a request picks among them, records which one answered, and works out what it really costs.

Code: `services/core/src/openrouter/` (Core), `apps/cockpit/src/openrouter/` (Cockpit), `packages/contracts/src/openrouter.ts` (shapes). Configuration: `config/openrouter.yaml`.

## Adding OpenRouter models

OpenRouter models are added one at a time, from **Admin → Models → Add a model → OpenRouter** (see [models](models.md#adding-a-model)). `config/models.yaml` ships none, and the catalogue is only ever browsed there, never listed in a picker. A model you add needs your OpenRouter key: until it is saved the model shows as **Needs its key** in Admin → Models and no picker offers it. Saving your first OpenRouter key (in that dialog, in setup or in Settings → API keys) switches on the OpenRouter models you added, and only those.

## Why the same model can feel worse

- **Precision matters less than expected.** Many labs release at FP8 or FP4, so an FP8 endpoint is often the original. `config/openrouter.yaml` records the lab's own precision with a source link; without an entry the explorer says "Unknown" rather than guess.
- **Context caps.** An endpoint may read only part of the model's window. Long threads and documents are then cut before the model sees them.
- **Output caps.** An endpoint may cap the answer. Reasoning models that run out of room mid-thought look careless; they were stopped.
- **Missing tools.** Some endpoints do not support tool calls at all.
- **Caching.** The price sort ranks by list price and ignores cache discounts and hit rates.
- **Auto Exacto.** For requests with tools, OpenRouter reorders providers by tool-calling success. `provider.sort: "price"` and the `:floor` suffix turn it off (OpenRouter's docs say so); any `order` or `sort` NVX Ancile sets replaces its ordering, and the Cockpit says so.

The in-app explainer is the help article `openrouter-quality`, linked from the explorer and the routing presets.

## Endpoint explorer

Admin → Models → a model's **⋯** → **Providers, routing and cost**. GET `/api/v1/openrouter/endpoints?model=<author/slug>` reads `https://openrouter.ai/api/v1/models/<author/slug>/endpoints` (public, no key) through `tracedFetch` with retry. Columns: precision (and whether it is the lab's original), context (as a share of the native window), max output, tools, input, output and cache-read prices (USD per million tokens), uptime over the last 30 minutes. Warnings are words: "This endpoint can only read 9% of what the model can", "Answers capped at 4,096 tokens: reasoning will be cut off", "Can't use tools", a reduced or unknown precision, low uptime, no cache discount.

Lists are kept in memory for `endpoints_ttl_minutes` (default 30) and saved in `core.settings` (`openrouter.endpoints.<model>`), so the explorer and routing still work offline; the table then says when it was read. A `:floor` or `:nitro` suffix is dropped for the lookup. `openrouter/auto` has no endpoints of its own.

## Routing presets

A choice (`RoutingSettings`) applies, most specific first: a flow step's own (`params.routing` on model, manager and router steps), the thread's, the notebook's, the model's, else Recommended. Thread, notebook and model choices live in `core.settings` under `openrouter.routing.<scope>.<id>` (GET/PUT `/api/v1/openrouter/routing`). The gateway builds OpenRouter's `provider` object per call (`buildRouting`, pure) and sends it with `usage: {include: true}`; a routing failure never stops a call.

| Preset | Sends | Auto Exacto |
| --- | --- | --- |
| Recommended | `require_parameters: true`, `ignore` endpoints whose context or max output cannot hold this request (estimated tokens plus max_tokens) or that lack tools when tools are sent; `max_tokens` from the choice, else the model's max output | kept |
| Best quality | `order` and `only`: providers trusted in config first, then original-precision endpoints by uptime and context; reduced precision left out | replaced |
| Lowest real cost | `order` by the cost of a typical turn at this person's cache hit rate and input share (usage history), `allow_fallbacks: true`; never `sort: "price"` | replaced |
| Fastest | `sort: "throughput"` (like `:nitro`, without its priority tier) | replaced |
| Pinned | `order` and `only` as chosen, `allow_fallbacks: false` | replaced |
| Advanced | the provider object exactly as typed (every field: order, only, ignore, allow_fallbacks, require_parameters, data_collection, zdr, quantizations, sort, max_price) | off when it orders or sorts |

Every preset also takes "Do not allow data collection" (`data_collection: "deny"`), a precision floor (`quantizations` at or above it; unknown never passes) and providers to avoid. POST `/api/v1/openrouter/routing/preview` answers what would be sent and notes in words.

## Which provider served

OpenRouter puts `provider`, `model` and `usage.cost` on its stream. The gateway reads them (`servedExtractor`) and the conductor records `usage.served = {provider, model, cut_off}` on the message (`cut_off` when `finish_reason` is `length`); the billed cost replaces list price. Why shows "Served by …" and, when cut off, "Cut off by this endpoint's output limit" with **Retry on an endpoint with more room** (saves a thread routing that avoids that provider and doubles the room, then regenerates). Usage groups OpenRouter answers by provider and filters with `GET /usage?provider=`.

## Cost calculator

POST `/api/v1/cost/estimate`: input, output and cache-write tokens a turn, cache hit rate (empty: this person's own for the model, from GET `/usage/history`), messages a day. Answers cost a turn, a day and a 30-day month per endpoint, ranked by the real invoice, with list price beside it; whether each endpoint can hold the turn; a RunPod break-even (GPU $/hour against the cheapest endpoint's per-token cost) and hours of GPU the month's answers need; Claude Code's plan headroom. Reachable from a model's dialog and from a flow step.

## Choosing a model

Admin → Models → **Help me choose**. POST `/api/v1/advisor` with a sentence or a kind (agent with tools, long documents, chat, coding, reasoning-heavy, cheap bulk) and budget, privacy and speed. Scoring is deterministic over the models you have, local models not yet downloaded and your usage history; it answers up to three options, one per place where possible (OpenRouter, this computer, your GPU, Claude Code, a direct provider), with reasons and the routing preset. It never calls a paid model. TODO(phase-5b): the optional short explanation from a running local model is wired in the route (`explain`) but not yet connected in `main.ts`.

## openrouter/auto

Auto picks a model per request. The registry plans for it at `AUTO_SAFE_WINDOW` (32,768 tokens) and 8,192 output tokens, so context assembly and flows never overflow; a window learnt from a served model only ever narrows that, since the next request may go elsewhere. Its cost is what OpenRouter billed, and the served model and provider are recorded like any other. Scopes treat it as cloud. Routing for Auto sends only the general fields (no endpoint exclusions).

## Quantization for local and rented models

- **Ollama:** entries in `config/local-models.yaml` may list `params_b` and `quant_tags` (q4_K_M, q5_K_M, q8_0, fp16 → Ollama tags). Download a local model offers them with size and memory estimates and the trade-off in words; POST `/local-models/:id/download {quant}` pulls that tag (`local_model.quant_unavailable` otherwise).
- **RunPod / vLLM:** `CreateNodeSpec.vllm = {model, quantization: original | awq | gptq | fp8, max_model_len}` becomes the node bootstrap's `ANCILE_MODEL` and `ANCILE_VLLM_ARGS` (`vllmEnv`); values already in `env` win. `memoryEstimateGb` and `vramFit` give the fit against a GPU's memory. TODO(phase-5): a node creation form in Compute that uses them.
