# Prompt caching: a request that starts the same way

Every provider caches a request by its exact start (Anthropic with markers; OpenAI, DeepSeek, Kimi, GLM and Gemini by themselves). Change anything near the top and every token after it is read again at full price. So NVX Ancile builds each request so that **turn N+1 starts with exactly the bytes of turn N**: tools, system prompt, then every earlier message as it was sent, with only new content added at the end.

Code: `services/core/src/conductor/epoch.ts` (epochs, tools block, context block), `conductor/pipeline.ts` (the turn), `gateway/convert.ts` (stored sent forms), `gateway/replay.ts` (reasoning, CA1), `gateway/cache.ts` (per-provider settings, CA5, and lifetimes, CA12), `threads/cache-state.ts` (CA12), `threads/compact.ts`, `conductor/overhead.ts` and `conductor/refit.ts` (HO1). Shapes: `packages/contracts/src/epochs.ts`, `cache.ts`. Tests: `test/conductor/epochs.test.ts`, `test/gateway/reasoning-replay.test.ts`, `test/gateway/cache-settings.test.ts`, `test/threads/cache-state.test.ts`, `test/threads/handover-levels.test.ts`, `test/conductor/handover-fit.test.ts`.

## Reasoning effort

A thread's reasoning effort (`low`, `medium`, `high`; `PATCH /threads/:id {effort}`, the chip beside the model chip, or `/effort`) rides on each request as a **request parameter in the provider's own words**, never as text in the prompt (`gateway/effort.ts`, the `reasoning.effort` section of each profile). It is **not** an epoch reason: changing it leaves the system prompt, tools and every earlier message byte for byte as they were, so the cached start of the conversation holds. Turning thinking itself on or off still starts an epoch (`thinking_toggled`).

| Provider | Sent as | Levels |
|---|---|---|
| Anthropic | `effort` option (`output_config.effort`) | low, medium, high |
| OpenAI (o-series, gpt-5) | `reasoning_effort` | low, medium, high |
| Google | `thinkingConfig.thinkingLevel` (Gemini 3 and later), `thinkingBudget` of 1,024 / 8,192 / 24,576 tokens (2.5) | low, medium, high |
| OpenRouter | `reasoning.effort` in the body | low, medium, high |
| xAI (`grok-*-mini`) | `reasoning_effort` | low, high |
| Ollama (gpt-oss) | `think` set to the level | low, medium, high |

Any other model takes none: the chip is not shown and a value sent anyway is dropped (other Ollama models only think or not; DeepSeek, Kimi, Qwen, GLM and the rest have no effort option in their profile yet). Higher effort can use more tokens, so the cost shown for a turn can change with it.

## Epochs

An **epoch** is the stretch of one thread branch where the start of the request does not change. It freezes:

- the system prompt (rules, the tools note, the pinned-memory snapshot, the thread's instructions, the model's display name);
- the tools block, as the exact text sent, and its SHA-256;
- the memory snapshot's commit, and which memory the model has been told about since.

It is stored in `core.prompt_epochs` (text columns, never jsonb, which would reorder keys). An answer records its epoch in `core.messages.epoch_id` and in `provenance.epoch`, so the epoch of a branch is found from the latest answer on its path. A fork inherits the epoch of the answers before it.

A new epoch starts only for one of these reasons (`EPOCH_REASONS`), logged as `prompt epoch started` with the reason:

| Reason | When |
|---|---|
| `new_thread` | The first turn of a thread, or of a branch with no earlier answer. |
| `compaction` | The compaction summary the path uses is not the one the epoch started with. |
| `model_family` | The model's family changed, it gained or lost the tools capability, or its family's switch below changed. |
| `tools_changed` | A tool the epoch declares has a new description or input schema (a log warning names its server). |
| `thinking_toggled` | `settings.thinking` changed (`PATCH /threads/:id` with `thinking`). |
| `memory_refresh` | The thread was idle longer than the provider's cache lifetime (the shortest `cache.ttl` in `gateway/profiles.ts`, five minutes when unpublished) and something frozen would read differently now: pinned memory, instructions, the model's name, the prompt template, or a tool that has appeared or gone. |

Nothing else starts one: not time passing, not the date, not memory written mid-thread, not an MCP server reconnecting or arriving.

## What varies goes at the end

Nothing that varies is in the system prompt. For the newest question, one delimited context block comes first in the same user message, then the question:

```
Context for the latest question only. NVX Ancile added it; the user did not write it, and it is not a question to answer:

Today's date: 2026-10-19 (UTC).

Memory update (commit abc1234). This replaces the matching notes in the memory block of the system prompt:
...
Memory that may bear on this question:
...
Instructions update. These replace the instructions in the system prompt:
...
<compaction summary, or the engine's recall note>

Instructions for this answer only:
... (Beam fuse, judges, review)

Tools connected since this conversation began. Call them through mcp_call with the name and arguments:
- late__ping: ... arguments (JSON Schema): ...

<this turn's sources and linked summaries>

---

The latest question, to answer now:

<the question>
```

Pinned memory is a snapshot frozen with the epoch. Memory written mid-thread is told once, as "Memory update (commit <short sha>)", and remembered as told; the next cold point folds it into a new snapshot. The compaction summary is told once, in the turn that started its epoch.

## The tools block

One sorted superset of the tools the notebook may use (never another notebook's: `ToolSpec.notebookId`), schemas serialised with sorted keys, `toolChoice` fixed at `auto`. Permissions decide what may **run**, never what is declared: a subagent, or a model without permission, sees the same list, and a call that is not allowed is refused with a reason at the moment it runs (`permissions/decide`, on the real arguments). A model without the tools capability is its own lane and is declared none.

- A server reconnecting with the same tools changes nothing.
- A tool from a server that connected mid-epoch is not declared. The block always declares one `mcp_call` tool (`name`, `arguments`), and the context block lists what it reaches. The call is checked, approved and run as the tool it names, with its real arguments; `mcp_call` reaches MCP tools only. At the next epoch the tool becomes native.
- A tool removed mid-epoch stays declared. A call to it is refused with "is not available now".

## Stored as sent

`core.messages.sent` holds each message exactly as it was sent, as text: a question with its context block (and so its source passages), an answer as the provider messages it expands to (the model's own tool arguments, results in call order, continuation text after them). It is written once and used as stored on every later turn, so a later caption, a rule change or a changed part never rewrites what a provider already saw. Messages without one (older ones, images, files, flow answers, other engines) are rebuilt from their parts, as before. Step durations and approval expiries live on the part, never in a tool result the model reads.

A steering note (CH7) is part of the answer it was added to: it is stored at the part where it was taken (`provenance.steered[].part`), sits between the work before and after it in every later round, and an answer that took notes stores its sent form with the notes in place, so the next turn sends the same bytes. Without a stored form it is rebuilt the same way from parts and provenance (`spliceNotes`).

Stored passages stay in the history, so a long grounded thread grows by its passages each turn. They are pruned only at an epoch. TODO(phase-0.2.0): CA9 prunes old passages at a new epoch.

## Small models and the per-family switch

Some small models follow instructions at the end of a request less well than at the top. The layout is behind a switch per model family, **on by default**. Setting `cache.end_context` to `{ "<family>": false } ` keeps the date, memory, notes and this answer's instructions in the system prompt for that family, as before. Tools are still one canonical block, and sent forms are still stored. The Flow lab's evals use it to compare. Turning it off or on starts a new epoch (`model_family`).

## Reasoning is kept and sent back by each provider's rule (CA1)

Reasoning is stored exactly as it arrived, as parts (`ReasoningPart.provider_meta` holds what a provider signed; `ToolCallPart.provider_meta` holds a thought signature) and inside the stored sent form. What goes back is decided per call from the provider's `reasoning` section in `gateway/profiles.ts` (`replayFor`):

| Provider | Sent back | Across a change of epoch | A cancelled stream |
|---|---|---|---|
| DeepSeek (with tools) | every earlier `reasoning_content`, on the message it came from | kept (DeepSeek wants all of it) | kept as far as it got |
| Kimi, MiniMax (always), GLM, Qwen (with tools) | `reasoning_content` as above | kept | kept as far as it got |
| Anthropic | each thinking block with its signature, unchanged, before its tool call | **not sent** from another epoch (its signature belongs to that epoch's thinking settings) | a block with no signature is dropped whole |
| Gemini | the thought signature on each function call; no reasoning text | kept | n/a (the signature rides on the call) |
| OpenRouter | `reasoning_details` on the assistant message, as received (streamed pieces are joined by index) | not sent from another epoch for a Claude model behind it | no details, nothing sent |
| OpenAI, xAI, Mistral, Groq, Ollama, Cohere, unknown, your own server | none | n/a | n/a |

A provider's own signatures never travel to another provider. An answer stored before reasoning was kept is rebuilt from its parts for a provider that wants reasoning: the same bytes every turn after that, but one miss at the switch. Plain text cannot be rejected for being short, and DeepSeek may refuse a missing block, so those providers keep what arrived; a signed block that was cut off would be rejected, so it is dropped whole.

Reasoning that is sent back counts in the context budget (`threads/compact.ts`, `partsText`); reasoning that is not sent does not.

## Per-provider cache settings (CA5)

Every request carries a `cache` scope: thread, branch, epoch, and a shard for calls that run side by side (Beam members, judges). The **cache key** is `nvx-` plus the first 32 hex characters of SHA-256 over those ids: the same for every turn of a branch in an epoch, different across branches, epochs and shards, never random. The branch is the first message after the nearest fork on the path (an edited question or a regenerated answer), or the first message of the thread.

| Provider | Setting |
|---|---|
| Anthropic | At most four `cache_control` markers (5 minute lifetime; the 1 hour option costs twice on writes and waits for CA11): after the rules, after the snapshot (the system prompt goes as two blocks, split by the epoch), and rolling on the last two messages, so each turn finds the last turn's marker inside the 20 block lookback. With no split, on the last tool and the system prompt instead. A marker whose prefix is under the model's minimum (512, 1024, 2048 or 4096 tokens by model line, 4096 when unknown) is left off. |
| OpenAI | `prompt_cache_key` is the key. |
| Mistral | `prompt_cache_key` is the key. |
| xAI | `x-grok-conv-id` is the key. Fireworks and Cloudflare get `x-session-affinity` from their profiles. |
| OpenRouter | `session_id` is the key; `transforms: []` (middle-out squeezing would rewrite the prompt); `cache_control` for Claude models (unconfirmed). Once a call has written or read the cache, the next go to the same upstream (`order`, `only`, `allow_fallbacks: false`) with the routing that warmed it, so the choice is not made again each call. The pin lapses after ten quiet minutes. If the pinned upstream is down (a transient or capacity error, or a 404, 502, 503 or 504 before any output) the call is asked again unpinned, logged as `pinned OpenRouter provider failed` and recorded in `provenance.cache_resets`. |
| Kimi | Nothing yet: its TTL option costs extra on writes (CA11). |

Markers and keys are functions of the request, so a retry (the Gateway asking the same model again after a short rate limit) sends the same bytes. Models go out under the id the catalogue holds; dated ids are the catalogue's business (MD4, MD5).

## Which models have this thread cached (CA12)

`GET /api/v1/threads/:id/cache-state`, for the model picker. Built from the per-call usage on each answer (`Usage.calls`: when it began, how long it took, what it read and wrote) and the provider's cache lifetime.

```
{
  items: [{
    model_id,        // concrete id
    provider,
    warm_until,      // ISO, or null when cold
    prefix_tokens,   // what the next call would read from cache if warm
    cold_cost_usd,   // prefix_tokens at the fresh input rate now (off-peak applies); null on a plan
    reported,        // false: the provider reports no cache figures, so this is a guess from its last call
    plan?, local?,   // plan: no per-token cost. local: cost 0, only time
    ttl_assumed?     // the lifetime is a lower bound, not a published figure
  }],
  thread_tokens,     // the newest call's prompt plus its answer
  candidate?: { model_id, warm, prefix_tokens, cold_cost_usd, plan?, local? }   // with ?candidate=<model id>; an alias is resolved
}
```

A model is warm while its last cache-touching call plus its lifetime is still ahead. A provider that reports figures and read or wrote nothing is cold. Lifetimes are the shortest in the profile: Anthropic 5 minutes (what is asked for), OpenAI 5 minutes (in-memory is 5 to 10 of quiet), Kimi and Qwen 5 minutes, Gemini 1 hour (unconfirmed), Groq 2 hours, Together 1 hour (unconfirmed), DeepSeek 1 hour (assumed; its docs say "a few hours to a few days"), and 5 minutes, assumed, for any provider that lists none. Epoch cold points (`cacheTtlMs`) keep their own, longer, figure for OpenAI. An unknown candidate is a 404. Answers stored before per-call usage have no calls and are left out.

## Changing model: what the new model reads (HO1)

A thread is not rewritten when the model changes; what changes is what the next model is shown of it. The original messages are never touched.

- **A summary is kept at three sizes.** A compaction saves the same cut as a `page` (about 1,500 tokens, written by the utility model), a `paragraph` (about 400) and a `line` (about 80), in `core.summaries` (`level`, and `for_window`, the window class of the model it was made for; migration 0044). The two smaller ones are cut from the page by a fixed rule (`shrinkSummary`: the first line of every section, then the rest in order), so they cost no model call and read the same every time. TODO(phase-5): model-written paragraph and line.
- **Each model reads the finest size its window holds.** `chooseCompaction` (`threads/compact.ts`): every turn while they stay under the warning line (80% of the window); else the finest summary of any cut that fits under the compaction line (95%); else every turn if they still fit; else the smallest summary there is, and a compaction is made for that window. A summary made for a smaller window does not shrink what a bigger one reads, and going back to the smaller model reads it again.
- **Windows are compared by class** (8k, 16k, 32k, 64k, 128k, 200k, 400k, 1M, 2M: the largest class a window reaches), so a 131k and a 128k model choose alike and the request stays the same turn to turn. A summary counts as made for "a window like this one" when its class is the same or larger, or was not recorded; then the summary applies even while every turn would fit (a Compact now you asked for is honoured). With "Watch the context window" off, nothing is chosen for a model: the newest summary applies, as before.
- **The budget counts the real request.** `conductor/overhead.ts` counts the system prompt (rules, tools note, the thread's instructions), the tools block (the canonical JSON the epoch declares) and the memory pack, in the turn and in `GET /threads/:id/context-budget`. The old flat 600 tokens for all three was about 1,000 in the offline test lineup (system 531, tools 473) and is far more with many tools connected.
- **Before a switch.** `GET /threads/:id/context-budget?model=<id>` carries `fit`: `needs_summary`, `tokens_now`, `tokens_after` (null when no summary can make it fit), `level` (`full`, `page`, `paragraph`, `line`) and `summary_ready`. The Cockpit asks it when you pick a model and, when it says `needs_summary`, waits for Switch and summarise (`POST /threads/:id/compact {model}` makes the summary for that window, then the switch) or Pick another. If the request fails, the switch goes ahead.
- **A fallback with a smaller window.** The turn is built for the first model of the chain. Before each model is asked (`Gateway.stream` `opts.fit`), a request that is over that model's window is rebuilt for it (`conductor/refit.ts`): the epoch's system text and tools stay as they are, the summary note and the turns it replaces are swapped for the size that window reads (a new compaction if none fits), and a stored sent form carrying the old note is rebuilt from parts so the note is told once. The answer records it as `provenance.refit`. If even the smallest summary cannot fit, the model is skipped: a `fallback` event with reason `context_overflow` and "<Model>'s 32k window cannot hold this thread, so it was skipped."; the last model in the chain failing that way ends the turn as before. A different model has a different cache anyway, so nothing cached is lost. Not done for a mixed thread's engine-fitted history, or while the watch is off.
- **Tool results cut for a model without tools** keep their start and end and say `[cut: N characters left out]` (`gateway/convert.ts`, `cutMiddle`).
- **Citations in earlier turns.** `[n]` numbers restart each turn, so an answer stored from now on has each marker written as the source it named (`[Pump manual, p. 12]`), in its stored sent form, in a history rebuilt from parts and in the text a summary is made from. `citation_ref` parts keep the page. Sent forms stored before this are not rewritten (that would break the cached start of every old thread).
- **Claude Code as a model** gets the same: its window is the lineup's, at most 200k, less 20k for its own setup (docs/engines.md).

## Not covered

Claude Code engine turns (Mode A and B) keep their own session and note (docs/claude-code.md). A mixed thread's fitted history (docs/engines.md) changes from turn to turn by design, so its start is not stable. A custom `prompts/system/base.md` that writes `{{now}}` outside a `{{#now}}` section gets no date in its system prompt; the date is in the context block.
