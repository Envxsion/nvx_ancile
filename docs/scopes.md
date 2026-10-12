# Scopes

A scope says what a notebook, or one thread in it, may use: which engines and models answer, whether anything leaves this machine, which sources, memory, tools, MCP servers and folders are in reach, and whether tools may use the network.

Scopes are floors. Permission presets, remembered grants and Auto mode's reviewer all work inside them and never past them.

## Fields

| Field | Meaning | Default |
|---|---|---|
| `engines` | Engines that may answer: `gateway_cloud`, `gateway_local`, `claude_code`, or another engine's id. `null` is any. | any |
| `models_allow` / `models_deny` | Model ids (globs, `/` separated, `**` for any depth). | any / none |
| `data_leaves_machine` | False: only local models, local reviewers and local tools. No cloud model, no Claude Code, no web. | true |
| `sources` | Source ids retrieval may read. `null` is every source in the notebook. | all |
| `context_links` | May context links (and context packs) from other threads and notebooks be read here (docs/notebooks.md). | true |
| `memory_read` / `memory_write` | May memory be read into a turn, and learned from after it. | true / true |
| `tools_allow` / `tools_deny` | Tool actions (globs, `.` separated, e.g. `fs.*`, `git.push*`). | any / none |
| `mcp_servers_allow` / `mcp_servers_deny` | MCP server names. | any / none |
| `folders` | Folders tools may touch. `null` leaves it to permissions. | workspace |
| `network` | May tools reach the network at all (including localhost). | true |
| `tool_preset` | A tool preset this level chose (below). `null` is none. | none |

## Tool presets

A tool preset is a named set of tool rules (`tools_allow`, `tools_deny`, `mcp_servers_allow`, `mcp_servers_deny`, `network`) that a notebook or a thread chooses with `tool_preset`. Three ship with NVX Ancile and cannot be changed (`BUILTIN_TOOL_PRESETS` in `packages/contracts/src/scopes.ts`):

| Preset | Allows |
|---|---|
| `research` (Research) | Web search and fetch, sources, notebooks, memory (read and propose), reading files, flows, MCP servers. |
| `coding` (Coding) | Files, the shell, git and GitHub, source search, memory, web search and fetch, MCP servers. Never `git.push_force`. |
| `read_only` (Read only) | Reading files and folders, git status, log, diff and branches, source search, notebooks, reading memory. No MCP servers, no network. |

Every built-in preset also allows Claude Code's own bookkeeping (`claude_code.*`: todo lists, subagents, plan mode); each subagent's own tool calls are checked again.

Your own presets are kept in `core.tool_presets` (`POST /tool-presets`). How they compose:

- A preset **only narrows**. Its rules are a separate layer, not merged into the level's own fields: a call must pass the scope's fields and then every preset in force (`EffectiveScope.tool_presets`, notebook first). So a thread may always choose a preset, and choosing one never widens its notebook. The notebook's preset keeps applying to every thread in it.
- The editor still shows each level's own lists; the preset is shown beside them.
- A preset that is deleted or no longer readable fails closed: no tool runs until another is chosen. A preset still in use cannot be deleted (`409 tool_preset.in_use`).
- Permissions still decide every call a preset lets through. A preset never grants anything.

## Inheritance: a thread can only narrow

The effective scope is worked out in this order: defaults, the private-notebook floor, the notebook's patch, the floor again, then the thread's patch.

- A thread can turn things off, pick fewer engines, models, tools, servers, sources or folders, and add to deny lists. It can never allow more than its notebook.
- A thread PATCH that would widen is **refused** (`422 scope.widen`), naming the fields. We refuse rather than silently clamp, so what you saw is what you get.
- If the notebook is narrowed later, a thread value that is now wider is **clamped** to the notebook when the scope is read, and listed in `clamped`.
- Every field carries its provenance: `default`, `private`, `notebook` or `thread`, with a note where useful. The Cockpit uses it to say why something was refused ("Set on the notebook", "Private notebook: local models only, nothing leaves this machine").

## Private notebooks

A notebook marked private (`PATCH /notebooks/:id/scope { "private": true }`, stored as `core.notebooks.private`) keeps everything on this machine:

- `data_leaves_machine` is false and `engines` is local only. Claude Code is never used.
- This is a floor, not a default: a notebook patch cannot switch it back on (`422 scope.private_conflict`), and stored values are clamped anyway.
- Auto mode asks only local reviewers (a local model, or the rules).

## Private after shared

Making a notebook private, or switching off data leaving the machine for a notebook or a thread, keeps everything here from then on. What went to cloud models before can't be called back, so NVX Ancile says plainly what it was.

- At the moment of the change, every answer in the notebook (all its threads) or the thread is grouped by its model and engine, from the answers' own records (`core.messages.model_id`, and Claude Code's provenance). Deleted answers count: they were sent all the same. Local models (Ollama, local, a node you control) are left out.
- The summary is kept in `core.scope_shared_history` and returned with the scope as `shared_before_local`: which engines and providers (a closed set: Claude Code, Anthropic, OpenAI, Google, OpenRouter, Mistral, Groq, DeepSeek, xAI, other cloud providers), how many answers, and the first and last date. No content, no titles and no model ids.
- The scope editor shows it as "Sent before it became private": "Before this notebook became private on 12 Oct 2026, 14 answers came from models off this computer: Anthropic (10), Claude Code (4), from 1 Oct 2026 to 9 Oct 2026. What was sent to them then can't be recalled from here." A thread shows its own records and its notebook's.
- Only a change that stops data leaving is recorded; narrowing anything else is not.

## Where scopes are enforced

Always at execution time, from the scope as it is now:

- **Every tool call**, in every preset, in the permission gate before `decide()` (`permissions/gate.ts`): tools, MCP servers, folders, network, data leaving the machine and memory tools. A refusal is a gate decision with `via: "scope"` and a `scope.*` code, logged as `policy_deny` with the field as its policy id.
- **Auto mode** checks the scope again after its reviewer answers.
- **Retrieval** (`conductor/pipeline.ts`): only sources in the scope are searched; when none are, the turn goes ungrounded.
- **Memory**: not read into a turn when `memory_read` is off, not learned from when `memory_write` is off.
- **Engines and models**: engine selection calls `checkEngineAllowed(scope, { engine, modelId, local })` from `services/core/src/scopes`.
- **Images** (docs/images.md): an attached image goes wherever its turn goes, so the engine and model check covers it. `image_generate`'s resource is its provider's URL, so a cloud provider is data leaving the machine; where nothing may leave, only a provider on this computer runs. Remote images in answers are never loaded there.

What the Why view shows: the thread's effective scope, and for each tool decision refused by a scope, the field and the level that set it.

- **Context links and context packs** (`scopes/combine.ts`, `checkLinkRead`): every read across a link passes the reading side's scope and the linked side's. The reader must allow `context_links`; a private or local-only place is read only where nothing leaves this machine (never by Claude Code, never where a cloud model may answer); the linked side may not allow fewer engines or models than the reader; only the sources its scope lets retrieval read are searched. Checked when a link is made (403 with the scope's code) and again on every read.

## Where two scopes meet: a notebook merge

The merged notebook takes the narrower value of every field and private wins: switches only if both are on, deny lists combined, allow lists only what both allow, and each notebook keeps its own limit on its own sources. A second, different tool preset is folded into the notebook's own tool fields. See docs/notebooks.md.

TODO(phase-3): Flows retrieval (`flows/turn.ts`) does not read the scope yet.

## For code

```ts
import { getEffectiveScope, checkEngineAllowed, checkToolCall } from '../scopes';

const scope = await getEffectiveScope(sql, { threadId }); // or a ScopeStore
const ok = checkEngineAllowed(scope, { engine: 'gateway', modelId: 'ollama/llama3', local: true });
if (!ok.ok) throw /* an AncileError with ok.code and ok.reason */;
```

A thread's notebook is always read from the thread, so a caller cannot dodge the notebook's scope by leaving it out.

API: see docs/api.md (Scopes). Errors: docs/errors.md (Scopes).
