# Prompt caching: a request that starts the same way

Every provider caches a request by its exact start (Anthropic with markers; OpenAI, DeepSeek, Kimi, GLM and Gemini by themselves). Change anything near the top and every token after it is read again at full price. So NVX Ancile builds each request so that **turn N+1 starts with exactly the bytes of turn N**: tools, system prompt, then every earlier message as it was sent, with only new content added at the end.

Code: `services/core/src/conductor/epoch.ts` (epochs, tools block, context block), `conductor/pipeline.ts` (the turn), `gateway/convert.ts` (stored sent forms). Shapes: `packages/contracts/src/epochs.ts`. Tests: `services/core/test/conductor/epochs.test.ts`.

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

Stored passages stay in the history, so a long grounded thread grows by its passages each turn. They are pruned only at an epoch. TODO(phase-0.1.1): CA9 prunes old passages at a new epoch.

## Small models and the per-family switch

Some small models follow instructions at the end of a request less well than at the top. The layout is behind a switch per model family, **on by default**. Setting `cache.end_context` to `{ "<family>": false } ` keeps the date, memory, notes and this answer's instructions in the system prompt for that family, as before. Tools are still one canonical block, and sent forms are still stored. The Flow lab's evals use it to compare. Turning it off or on starts a new epoch (`model_family`).

## Not covered

Claude Code engine turns (Mode A and B) keep their own session and note (docs/claude-code.md). A mixed thread's fitted history (docs/engines.md) changes from turn to turn by design, so its start is not stable. A custom `prompts/system/base.md` that writes `{{now}}` outside a `{{#now}}` section gets no date in its system prompt; the date is in the context block.
