# Engines: one thread, any model

A thread in NVX Ancile can be answered by more than one engine, turn by turn:

- **The gateway**: every model you have set up (cloud, local, your GPU nodes), with NVX Ancile's own tools, memory, sources and compaction.
- **Claude Code**: your own installed Claude Code, carrying on the session behind a Claude Code thread (docs/claude-code.md).

A Claude Code thread can take a turn from GPT-5 or a local model and go back to Claude Code afterwards; a plain thread can ask Claude Code as a model. The thread keeps its Claude Code binding throughout.

Code: `services/core/src/engines/`. Shapes: `packages/contracts/src/engines.ts`.

## Choosing an engine

The engine is chosen for each message from its model id (`engines/select.ts`):

| Thread | Model asked for | Engine |
|---|---|---|
| Bound to a Claude Code session | none, or the thread's model is a `claude-code/…` one | Claude Code, carrying the session on (Mode B) |
| Bound to a Claude Code session | `claude-code/<model>` | Claude Code, the session on that model (`claude-code/default` keeps its default) |
| Any | any other model id | The gateway; a bound thread keeps its binding |
| Not bound | `claude-code/<model>` | Claude Code as a model, through the gateway (Mode A) |
| Not bound | none | The gateway: the thread's model, then the route |

Before anything runs, the thread's scope is checked (`scopes/checkEngineAllowed`) with the engine, the model that would answer and whether that model runs on this machine. Claude Code never counts as local. A refusal is an error with the scope's own code (`scope.private_notebook`, `scope.data_stays_local`, `scope.engine_not_allowed`, `scope.model_not_allowed`) and nothing is written. The same check runs when a turn goes straight to `POST /claude-code/threads/:id/send`.

`POST /api/v1/threads/:id/turns` is the one front door (docs/api.md, Engines). The older routes still work: `POST /threads/:id/messages` always uses the gateway, and `POST /claude-code/threads/:id/send` always uses the session.

## Context for each engine

Each engine is given the thread within its own budget, and never more (`engines/context.ts`).

### A gateway model in a mixed thread

When the path being answered holds turns by another engine (Claude Code), the gateway model reads:

1. **The compaction summary** for the older path, when one applies. It is NVX Ancile's own (DESIGN.md §8.4): cached, built once per shared prefix, and built incrementally on the previous summary.
2. **The last three turns** as they are, except that every tool step is one line: "read src/app.ts (420 lines)", "edited src/app.ts +12 −3", "ran `pnpm test` → exit 0", "subagent: Find the bug → The bug is in auth.ts". Thinking is left out. Full tool outputs are never sent again (`engines/digest.ts`).
3. **Older turns**: all of them if they fit; otherwise the ones that bear on the question, in a block marked "Earlier in this thread". Relevance is BM25 over the thread's own turns (their digested text), computed in Core for each turn (`engines/recall.ts`). Knowledge's hybrid search was not used: a thread's turns are not sources, indexing every message would embed the whole history and add a network call to every turn, and a path rarely holds more than a few hundred turns. TODO(phase-5): fastembed embeddings for very long threads.
4. **The notebook's sources**, from the conductor's usual retrieval.

The budget is the model's context window, less a reserve for the answer (its maximum output, at most a quarter of the window), less the system prompt, memory, sources and instructions. The latest turns come first; the summary takes at most half of what is left; older turns fill the rest. The question being answered is always sent, with its middle cut if even it does not fit. Tokens are estimated at about four characters each, as compaction does. TODO(phase-5): a tokenizer per model family.

A thread with no other engine's turns keeps the conductor's own history exactly as before. Only the instructions (below) are added.

The answer records what it was given in `provenance.engine_context` (`EngineContextReport`): the window, the reserve, the tokens sent, the summary used, how many messages went as they are, how many tool steps were digested, which messages were recalled and how many were left out.

### Claude Code

Claude Code's session holds its own history, so NVX Ancile never sends it again. A turn goes on from Claude Code's latest message on the branch (the session's place) and carries only:

- a short digest of the turns other engines took since then (theirs and your questions to them), marked `<ancile-context>` and introduced as context, not instructions;
- at most about 2,000 tokens, newest first, each message at most about 1,600 characters, tool steps as one-line digests.

The thread shows your words only; the digest goes to Claude Code alone. When a turn sends some of the thread to Claude Code, the run's first event after `model` is one `context.shared` event (`notice`: "This thread's context will be sent to Claude Code"), and the send answers with `context_notice` set, so the composer can show the line once.

If Claude Code went on past its latest message in another branch, the turn forks the session there, as any branch does. If the branch has no Claude Code message at all (a branch started with another model), the turn starts a new session given the branch so far as its digest.

## One compaction for mixed threads

NVX Ancile's compaction summary is the record of a mixed thread. When the next Claude Code turn comes after an NVX Ancile compaction its session has not been given, the turn **starts a fresh Claude Code session seeded with the summary**: the prompt carries the summary and a digest of the turns since it, then your words. The new session is bound to the same thread (like a fork), and `core.engine_sessions` records that it has seen that summary, so later turns go on in it with nothing extra. The answer's `engine_context.seeded_from_summary` is true and the `context.shared` event says so.

Why not Claude Code's own `/compact <summary as instructions>`: it would spend a second, full summarising call on your Claude Code usage before every such turn, and Claude Code would write its own summary, guided by ours but not the same, so the thread would have two records that drift apart. A seeded session costs nothing extra and holds exactly NVX Ancile's summary. What it gives up, Claude Code's memory of files it read earlier, is what any compaction gives up.

Seen summaries are tracked per session, and a session is one branch's place in Claude Code, so two branches each get the summary once.

## Instructions and persona

A thread and a notebook can each have instructions and a persona (`AncileInstructions`), and every engine follows them. The thread's own value wins over its notebook's, field by field.

- **Gateway models** read them in the system prompt, every turn.
- **Claude Code** reads them in the note appended to its own system prompt, after NVX Ancile's base note (where it runs, how to search and cite the notebook's sources). The note never changes from turn to turn, so Claude Code's prompt cache holds; a session is reopened only when the note itself changes.

Routes: `GET/PUT /threads/:id/instructions`, `GET/PUT /notebooks/:id/instructions`.

## Memory

When Claude Code writes to its own memory (a `CLAUDE.md` in the session's folder, `~/.claude/CLAUDE.md`, its auto-memory folder, or the memory tool), the lines it added are offered to NVX Ancile's memory as proposals: at most three per write, the project's to the notebook's `PROJECTS` file, yours to `USER.md` (`engines/memory.ts`). They are tool output, so they are only ever proposed, never applied without a yes (DESIGN.md §6.3). Claude Code's own write is a file write like any other, decided by the permission gate before it ran.

## Claude Code as a model (Mode A)

When Claude Code is installed, up to date and verified, its models are in the model list as `claude-code/default`, `claude-code/opus`, `claude-code/sonnet` and `claude-code/haiku` (provider `claude_code`). They work wherever a model does: a thread's model, a routing chain in Admin → Routing, a flow's node.

- Each call is one Claude Code turn in a session that writes no transcript, in NVX Ancile's own empty folder (`<data>/claude-model`), with every built-in tool off and none of your Claude Code settings loaded.
- When the call comes from a thread, NVX Ancile's MCP server for that thread is its only set of tools (the notebook's search, read a source, memory search, hosted MCP tools). Each tool call is decided by the permission gate as `agent:claude-code` on its real arguments: what is allowed runs, and anything that would need your approval is refused, because a model call inside a route cannot wait for a person. TODO(phase-4): approvals inside Mode A calls.
- Usage counts against Claude Code's own account. NVX Ancile prices these models at zero and shows token counts.
- Free in chat and routing. Inside Pro's Beam and the Flow lab, Claude Code models are Pro: the Pro seam (`pro/answers.ts`, `allowModel`) leaves them out of Pro's model list and refuses them, and a Flow lab run of a flow with a Claude Code node, unless the licence has Beam or the Flow lab at that moment.

## Adding an engine

An engine is an adapter (`engines/types.ts`, `Engine`):

- `id`, `kind` (a lower-case word; `gateway` and `claude_code` today), `displayName`, and the `modelPrefix` that chooses it.
- `capabilities()`: streaming, tools, images, `own_context` (it keeps its own conversation, like Claude Code), `context_window`.
- `status()`: whether it can answer now, and why not in words.
- `start(turn)`: start the turn as a run on the thread's usual event stream and answer once it is queued.

A future agent CLI (Codex, Gemini CLI) follows the Claude Code pattern:

- **A separate helper program.** Any SDK that is not GPL-compatible loads only in a helper like the Claude bridge, never in Core. The helper is downloaded at run time and checked against a pinned hash before it runs; nothing is bundled.
- **Never handle the CLI's credentials.** Use the CLI's own sign-in.
- **Every tool call through the permission gate** on its real arguments, at execution time, under its own principal (`agent:<cli>`).
- **An `own_context` engine** gets the Claude Code treatment: its history is never re-sent, other engines' turns go to it as a marked digest, and NVX Ancile's compaction seeds a fresh session.
- **A scope kind of its own**: `checkEngineAllowed` treats an unknown engine as cloud unless it says otherwise.
- **Telemetry** reports the engine only as `gateway`, `claude_code` or `other`.
