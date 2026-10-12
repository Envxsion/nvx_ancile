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
| `context_links` | May context links from other threads and notebooks be pulled in. | true |
| `memory_read` / `memory_write` | May memory be read into a turn, and learned from after it. | true / true |
| `tools_allow` / `tools_deny` | Tool actions (globs, `.` separated, e.g. `fs.*`, `git.push*`). | any / none |
| `mcp_servers_allow` / `mcp_servers_deny` | MCP server names. | any / none |
| `folders` | Folders tools may touch. `null` leaves it to permissions. | workspace |
| `network` | May tools reach the network at all (including localhost). | true |

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

## Where scopes are enforced

Always at execution time, from the scope as it is now:

- **Every tool call**, in every preset, in the permission gate before `decide()` (`permissions/gate.ts`): tools, MCP servers, folders, network, data leaving the machine and memory tools. A refusal is a gate decision with `via: "scope"` and a `scope.*` code, logged as `policy_deny` with the field as its policy id.
- **Auto mode** checks the scope again after its reviewer answers.
- **Retrieval** (`conductor/pipeline.ts`): only sources in the scope are searched; when none are, the turn goes ungrounded.
- **Memory**: not read into a turn when `memory_read` is off, not learned from when `memory_write` is off.
- **Engines and models**: engine selection calls `checkEngineAllowed(scope, { engine, modelId, local })` from `services/core/src/scopes`.

What the Why view shows: the thread's effective scope, and for each tool decision refused by a scope, the field and the level that set it.

TODO(phase-3): Flows retrieval (`flows/turn.ts`) and context links do not read the scope yet.

## For code

```ts
import { getEffectiveScope, checkEngineAllowed, checkToolCall } from '../scopes';

const scope = await getEffectiveScope(sql, { threadId }); // or a ScopeStore
const ok = checkEngineAllowed(scope, { engine: 'gateway', modelId: 'ollama/llama3', local: true });
if (!ok.ok) throw /* an AncileError with ok.code and ok.reason */;
```

A thread's notebook is always read from the thread, so a caller cannot dodge the notebook's scope by leaving it out.

API: see docs/api.md (Scopes). Errors: docs/errors.md (Scopes).
