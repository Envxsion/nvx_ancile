# API

Ancile has three HTTP surfaces:
- the Cockpit ↔ Core API (`/api/v1`)
- Core ↔ Knowledge (`/kn/v1`), internal
- Core ↔ Controller (OpenAI-compatible `/v1` plus `/control/v1`)

The schemas live in `packages/contracts` (zod), which is the single source of truth. Python models are generated from its JSON Schema export.

## Conventions

- **JSON in and out.** IDs are prefixed ULIDs: `thr_01J9…`, `msg_…`, `run_…`.
- **Every response has `x-trace-id`.** Send a W3C `traceparent` to join an existing trace.
- **Auth:** an httpOnly session cookie from `POST /api/v1/session` (required only when a passphrase is set). Service-to-service calls use `Authorization: Bearer <token>`.
- **Errors** share one shape. See [errors.md](errors.md):
  ```json
  { "error": { "code": "thread.not_found", "title": "That thread doesn't exist", "hint": "It may have been deleted. Check the trash in the rail.", "retryable": false, "trace_id": "…", "attempts": [], "context": {} } }
  ```
- **Pagination:** `?cursor=&limit=`. The response is `{ items, next_cursor }`.
- **Optimistic concurrency** on editable files (memory, notes): send `base_sha` or `If-Match`. A conflict returns 409 with both versions.
- **Idempotency:** side-effecting POSTs accept `Idempotency-Key`. Controller actions require it.

## Cockpit ↔ Core

The schemas in `packages/contracts/src/api.ts` are the full list. Worked examples follow.

### Send a message and stream the reply

```http
POST /api/v1/threads/thr_01J9ZK…/messages
Content-Type: application/json

{
  "parent_id": "msg_01J9ZM…",
  "parts": [{ "type": "text", "text": "Summarise the dropout findings across the three trials." }],
  "mentions": [{ "kind": "notebook", "id": "nbk_01J9ZA…" }],
  "client_message_id": "local-7f3a"
}
```

```http
HTTP/1.1 202 Accepted
x-trace-id: 4bf92f3577b34da6a3ce929d0e0e4736

{ "run_id": "run_01J9ZQ…", "user_message_id": "msg_01J9ZP…", "assistant_message_id": "msg_01J9ZR…",
  "stream_url": "/api/v1/runs/run_01J9ZQ…/stream" }
```

```http
GET /api/v1/runs/run_01J9ZQ…/stream
Accept: text/event-stream
Last-Event-ID: 41        ← only when reconnecting
```

```
id: 1
event: run.status
data: {"seq":1,"at":"…","type":"run.status","status":"running"}

id: 4
event: memory.injected
data: {"seq":4,…,"files":[{"path":"USER.md","commit":"a1b2c3d","entries":6,"tokens":212}],"truncated":0}

id: 7
event: text.delta
data: {"seq":7,…,"message_id":"msg_01J9ZR…","delta":"Across the three trials, "}

id: 58
event: done
data: {"seq":58,…,"message_id":"msg_01J9ZR…"}
```

Every event is listed in [events.md](events.md).

### Answer an approval

```http
POST /api/v1/approvals/apr_01J9ZT…
{ "decision": "approve", "scope": "notebook", "pattern": "fs:/workspace/notes/**", "ttl_seconds": 604800 }
```

`scope` is one of `once`, `thread`, `notebook`, `workspace` or `always`. Critical approvals accept only `once`; any other scope gets a 422 with code `permission.critical_not_rememberable`.

An approval whose tool takes changed arguments says `args_editable: true` and carries the full `args` (today: a live Claude Code session's tool calls). Approve it once with your changes:

```http
POST /api/v1/approvals/apr_01J9ZT…
{ "decision": "approve", "scope": "once", "updated_args": { "command": "npm test -- --run" } }
```

The permission is decided again on the changed arguments first: a deny refuses the answer (422 `permission.edited_args_denied`, the approval stays open); anything else runs the tool with them. `updated_args` with any other scope or with `deny` is 422 `permission.edit_needs_once`; on an approval that is not `args_editable` it is 422 `permission.args_not_editable`.

### Edit and revoke grants

```http
PATCH  /api/v1/grants/gnt_01J9…          { "resource_pattern": "fs:/workspace/notes/*.md", "scope": "thread", "ttl_seconds": 3600 }
DELETE /api/v1/grants/gnt_01J9…          → 204
POST   /api/v1/grants/gnt_01J9…/restore  → the grant (within ten minutes of DELETE, else 410 permission.restore_expired)
```

Every PATCH field is optional (`PatchGrantRequest`); `ttl_seconds: null` never expires. A pattern may only narrow (422 `permission.pattern_too_broad`), and under Careful a scope may not widen past `thread` (422 `permission.scope_too_wide`).

### Edit and remove models

```http
PATCH  /api/v1/models/<id>    { "display_name": "Pod coder", "context_window": 131072, "hue": "jade", "enabled": true }
DELETE /api/v1/models/<id>    → 204 (added models only, else 409 model.not_custom)
POST   /api/v1/models/restore { "id": "<id>" } → 201, the model (within ten minutes, else 410 model.restore_expired)
```

`PatchModelRequest` also takes `family`, `max_output`, `capabilities`, `price`, and for OpenAI-compatible models `base_url`, `api_key` (replace the key) or `secret` (a stored key's name; `null` for none). A model from `config/models.yaml` takes only `enabled` and `hue` (`hue: null` follows the family).

### Branch, compare, merge

```http
POST /api/v1/messages/msg_01J9ZM…/branch      { "name": "Try a Bayesian framing" }
POST /api/v1/threads/thr_…/compare            { "a": "msg_…head A", "b": "msg_…head B" }
POST /api/v1/merge                            { "picks": ["msg_…", "msg_…"], "strategy": "synthesize", "title": "Best of both" }
```

### Read a long thread a page at a time

```http
GET /api/v1/threads/thr_…/path?limit=60                     the head end: the last 60 messages of the path
GET /api/v1/threads/thr_…/path?limit=60&before=msg_…        the 60 before that message (scrolling up)
GET /api/v1/threads/thr_…/path?limit=60&include=msg_…       from just above that message to the head (jump to it)
```

`ThreadPath` with `total` (messages on the whole path), `start` (where `messages` begins in it; 0 is the root) and `has_more` (`start > 0`). `limit` is 1 to 500; `head` and `exact` work as without paging. A page never starts on a message that only carries tool results: it reaches back to the answer that asked for them, so a page can hold a few more than `limit`. `before` or `include` not on the path is a 404. Without `limit` the whole path comes back as it always has (`start: 0`, `has_more: false`). The path is worked out from the thread's shape alone (ids and parents) and only the page's messages are read, so a 20,000-message thread imported from Claude Code answers its last page in tens of milliseconds. `GET /threads/:id/tree` reads content only for the nodes it draws.

### Why did the AI say this?

```http
GET /api/v1/messages/msg_01J9ZR…/explain
```

This returns the `Explain` schema: the answering model and every attempt, the memory pack (files, commits, entries), retrieved chunks with scores and whether each was cited, tool calls with their permission outcomes, compaction, usage, and fact-check.

### Routing chains

`GET /api/v1/routing` lists each editable task class as a `RoutingChain`: `configured` (your saved order, or the YAML's), `default` (the YAML's), `custom`, and `chain` (who routing tries right now, counting only models that can answer). Saving and resetting answer with the updated `RoutingChain`:

```http
PUT /api/v1/routing/chat.default
Content-Type: application/json

{ "chain": ["openai/gpt-5.5", "anthropic/claude-sonnet-5-5"] }
```

```http
DELETE /api/v1/routing/chat.default      ← back to config/routing.yaml
```

A saved chain wins over `config/routing.yaml` in the gateway at once. Refused: an unknown task class (`routing.task_class_unknown`), an empty chain (`routing.chain_empty`), an id that is neither a model nor already listed for the class (`routing.model_unknown`), and an embedding or rerank model (`model.not_chat`).

### Compute (proxied to the Controller)

```http
POST /api/v1/compute/nodes/nod_01J9…/actions
Idempotency-Key: 5f1c2e9a-…
{ "action": "start", "idempotency_key": "5f1c2e9a-…" }

→ 202 { "operation_id": "opn_01J9…" }
```

Follow the confirmation chain on `/api/v1/events` (`node.operation`) or `GET /api/v1/compute/operations/:id`.

### Automations

```http
POST /api/v1/automations
{ "kind": "ask_model", "title": "Morning brief", "cron": "0 8 * * 1-5",
  "config": { "prompt": "What changed in my sources since yesterday?", "notebook_id": "nbk_01J9…", "model": null } }

→ 201 AutomationView
```

Kinds: `ask_model` (`prompt`, `notebook_id?`, `model?`), `run_flow` (`flow_id`, `prompt`, `notebook_id?`), `recheck_sources` (`notebook_id`), `notify` (`title`, `body?`). The schemas are `CreateAutomationRequest` and `UpdateAutomationRequest` in `packages/contracts/src/ops.ts`.

- `GET /automations` lists your own first, then the built-in jobs.
- `PATCH /automations/:id` takes `enabled`, `cron`, `config`, and `title` for your own. A built-in job's `config` may only hold its `options`, and is merged into what it has.
- `POST /automations/:id/reset` puts a built-in job back to `config/automations.yaml`.
- `DELETE /automations/:id` deletes one of your own.
- `POST /automations/:id/run` runs one now.

A schedule that can't be read is `automation.bad_schedule`; one more often than every 5 minutes is `automation.too_often`. Changes are kept in Core's database, never written to the YAML file.

## Core ↔ Knowledge (`/kn/v1`)

Internal, bearer `ANCILE_SERVICE_TOKEN`.

```http
POST /kn/v1/search
{ "query": "dropout rate", "notebook_ids": ["nbk_…"], "k": 12, "mode": "hybrid", "rerank": true }

→ { "items": [ { "chunk_id": "chk_…", "source_id": "src_…", "title": "Trial B final report",
                 "text": "…", "context_blurb": "…", "score": 0.031, "rerank_score": 0.92,
                 "char_start": 18231, "char_end": 18902, "page": 14, "heading_path": ["Results","Attrition"] } ] }
```

Knowledge calls back to Core's `/internal/v1/openai/chat/completions` and `/internal/v1/openai/embeddings` (OpenAI-compatible) for every model call, so the Gateway traces and routes them.

## Core ↔ Controller

- **Data plane:** standard OpenAI-compatible endpoints. The `model` field is a route alias. Core understands these errors:
  - `503 {"error":{"code":"node_waking","eta_s":80}}`: the request is queued; wait or fall back.
  - `402 {"error":{"code":"cost_cap"}}`: a policy veto; fall back without retrying.
- **Control plane:** `/control/v1/nodes`, `/nodes/:id/actions`, `/operations/:id`, `/operations/:id/stream`, `/costs`, `/rules`, `/routes`, `/events`. The whole contract is `packages/contracts/src/controller.ts`.
- **Conformance:** the suite in `services/controller/test/contract` checks any implementation that claims to be a Controller.

## Ancile as an MCP server (Phase 5)

`/mcp` (Streamable HTTP). Tools: `ancile.search`, `ancile.read_source`, `ancile.list_notebooks`, `ancile.memory_read`, `ancile.add_note`. Every call is permission-checked with the client as an `external:<name>` principal.

## MCP servers and tools

Under `/api/v1` (shapes in `packages/contracts/src/mcp.ts`, docs/plugins.md). Servers from `config/mcp.yaml` have the id `file:<name>` and are read-only here, except for their tools.

| Route | Does |
|---|---|
| `GET /tools` | Every tool the model can call, with tier and source |
| `GET /mcp/servers` | `{items: McpServerView[]}`: app and file servers, live status and tools |
| `POST /mcp/servers` (CreateMcpServerRequest) | 201 with the view; connects in the background (status `connecting`) |
| `GET /mcp/servers/:id` | One server's view |
| `PATCH /mcp/servers/:id` (UpdateMcpServerRequest) | Change an app server; reconnects when how it connects changed. `secrets` is the whole list: keys left out are deleted, a key without a value keeps the stored one |
| `DELETE /mcp/servers/:id` | 204; disconnects, removes its tools and secrets |
| `POST /mcp/servers/:id/test` | Reconnect now; the view after the attempt |
| `PATCH /mcp/servers/:id/tools/:tool` (UpdateMcpToolRequest) | Tier (`null` goes back to the server's own) or switch a tool off; applied at once |

Secret values are never returned: a secret is `{key, set}`. Changes are published as `mcp.server_changed`.

## Repositories and GitHub

Under `/api/v1` (DESIGN §17, docs/repos.md):

| Route | Does |
|---|---|
| `GET /repos` · `POST /repos {path, name?}` · `DELETE /repos/:id` | List, add (any folder inside the repository), remove |
| `GET /repos/linked?thread_id=&notebook_id=` · `POST /repos/link {scope, scope_ref, repo_id or null}` | The repository a place works in; link or unlink |
| `GET /repos/:id/status` · `/diff?path=&staged=` · `/log?limit=` · `/branches` | Branch, upstream, ahead/behind, changed files; diffs; history; branches |
| `POST /repos/:id/actions {op, …}` | `stage`, `unstage`, `commit`, `switch`, `pull` (fast-forward only), `push`, `fetch`, `stash`, `stash_pop`: the person acting, from the Repo panel |
| `GET /repos/:id/suggest-message` | A commit message drafted from the staged files |
| `GET /github/access` · `PUT /github/token {token or null}` | How GitHub is reached (gh, token, none); save or forget a token |
| `GET /repos/:id/pulls` · `POST /repos/:id/pulls {title, body?, base?, draft?}` | Pull requests; open one from the current branch |
| `GET /repos/:id/runs` · `/runs/:run/log` · `POST /runs/:run/rerun?failed=` | Actions runs, the failed log, re-run |
| `POST /mcp/presets/github {token?, read_only?}` | Add (or update) the official GitHub MCP server as an app server; answers `{server, runner, health, view}` |

## Works with Claude Code

Under `/api/v1` (docs/claude-code.md, shapes in `packages/contracts/src/claudecode.ts`):

| Route | Does |
|---|---|
| `GET /claude-code/status?fresh=1` | `ClaudeCodeStatus`: installed, version, path, sign-in (method and plan only, never the account's email or organisation), install state, `verification` of the install, the Agent SDK's state, settings. Cached for 10 s unless `fresh`. |
| `PATCH /claude-code/settings {auto_install?, auto_import?, exclude_folders?, claude_telemetry?}` | Save and answer `ClaudeCodeSettings`. Changing `exclude_folders` puts away what came from those folders (threads archived, never deleted; `claude_code.changed {what: sessions}`) |
| `POST /claude-code/install` | 202 `{state, error}`: runs Anthropic's official installer in the background (`claude_code.changed {what: install}` as it goes) |
| `POST /claude-code/sign-in {method?: claudeai, console or sso}` | 202 `{started}`: opens Claude Code's own sign-in (`claude auth login`); NVX Ancile watches `claude auth status` for up to 5 minutes |
| `POST /claude-code/sign-out` | 204: `claude auth logout`, only when the person asks |
| `GET /claude-code/sessions?q=&cwd=&limit=&cursor=` | `{items: ClaudeCodeSession[], next_cursor}`, newest first, across every project |
| `POST /claude-code/sessions/import {session_ids, notebook_id?}` | `ImportClaudeCodeSessionsResult`. Idempotent: an imported session is synced instead |
| `POST /claude-code/threads/:id/sync` | `{thread_id, session_id, added, gone}`: pull what is new; `gone` when the transcript is no longer on this computer (the thread stays) |
| `GET /claude-code/projects` · `PUT /claude-code/projects {cwd, notebook_id}` · `DELETE /claude-code/projects?cwd=` | Folder → notebook bindings (`{items: ClaudeCodeProject[]}`) |
| `POST /claude-code/projects/exclude {cwd}` | "Don't bring in this folder": adds it to `exclude_folders` (unless already covered) and puts away what came from it; answers `ClaudeCodeSettings` |
| `POST /claude-code/threads/:id/send` (`SendClaudeCodeRequest`) | 202 `SendClaudeCodeResult {run_id, user_message_id}`. One turn in the thread's live session: the user message is written at once (its parent is `parent_id`, else the active head), and a run of kind `claude_code` streams the answer on `/runs/:run_id/stream` like any other. A `parent_id` the session already went on from, or `as_branch: true`, forks the session there. `idempotency_key` makes a repeat the same turn. 409 `claude_code.session_busy` when Claude Code wrote the session from somewhere else in the last minute (send again with `as_branch`), `claude_code.branch_unmapped` when the parent did not come from Claude Code, `run.already_running` while a turn runs |
| `POST /claude-code/threads/:id/interrupt` | `{interrupted: true}`: stops the running turn (Claude Code's own interrupt); the run ends `cancelled` and keeps what streamed. Cancelling the run does the same. 409 `claude_code.not_live` when nothing runs |
| `GET /claude-code/threads/:id/live` | `ClaudeCodeLiveState`: `idle`, `starting`, `ready` or `working`; `locked_elsewhere`; the model, effort and permission mode Claude Code reports; the folder; `context` (Claude Code's own count) while a session is open |
| `GET /claude-code/threads/:id/commands?wait=` | `ClaudeCodeCommandList {items, partial}`: Claude Code's own "/" list for the session's folder (read from a session that sends nothing and writes no transcript; cached 10 minutes per folder and Claude Code version), merged with what NVX Ancile does itself (docs/claude-code.md, Commands). Answers at once: until that folder's list has been read, `items` is the built-ins and `partial` is true while the read goes on in the background (ask again shortly); `wait=1` waits for it. Core reads the lists for the two most recent Claude Code folders 45 s after it starts |

A turn's run events: `model` (display name "Claude Code"), `text.delta` and `reasoning.delta` as Claude Code streams, `tool.call` (with the tier the call maps to) and `tool.result` for each tool, `approval.required` when a call needs you, `citation` for each source passage the answer cites, `usage`, then `run.status` and `done` from the run itself. A restart during a turn ends it with a `warning` (`claude_code.recovered`) and brings in what Claude Code wrote from its session.

### MCP for live sessions

`/mcp/claude` (Streamable HTTP, stateless, outside the browser guard) is NVX Ancile's MCP server for the Claude Code sessions it runs, configured as the server `ancile` in each session. Its bearer token is `<thread id>.<HMAC of the thread id under a per-boot secret>`, so a call always knows its thread and cannot claim another; every call is checked by the gate as `agent:claude-code`.

| Tool | What it does |
|---|---|
| `search {query, k?}` | Hybrid search over the thread's notebook (the send's `source_ids`, when given). Passages come back as `[n] title · page · heading (source <id>, chunk <id>)`, numbered on from the turn's earlier searches; markers the answer uses become `citation_ref` parts |
| `read_source {source_id, offset?, limit?}` | A source of the notebook as Markdown, 20,000 characters at a time (up to 60,000); a source from another notebook is refused |
| `memory_search {query, limit?}` | What NVX Ancile remembers |
| every hosted MCP tool | Each server Core connects to (Admin → MCP servers), checked on its own action, resource and tier with the real arguments; an "ask" runs only on the pass your approval of that call left |

### Core ↔ Claude bridge

Core reads sessions through the Claude bridge (`services/claude-bridge`, MIT), a separate program it starts on first use and stops after five idle minutes. One WebSocket on 127.0.0.1 at a random port; Core passes a per-launch bearer token in the environment, and the bridge refuses any other token or a browser `Origin`. It prints `ANCILE_BRIDGE_READY {port, protocol, version}` on stdout when listening and exits when its stdin closes.

| Message | Shape |
|---|---|
| Request | `{id, op, params?, trace_id?}` |
| Reply | `{id, ok: true, result}` or `{id, ok: false, error: {code, message}}`; codes `bad_request`, `unknown_op`, `protocol_mismatch`, `hello_first`, `sdk_unavailable`, `unknown_handle`, `failed` |
| Push (protocol 2) | `{event, data}` with no id, on the connection that opened the session |

| Op | Params → result |
|---|---|
| `hello` (first) | `{protocol: 1 or 2, client}` → `{protocol, bridge, sdk}`. Core speaks 2; protocol 1 gets only the reading ops |
| `status.sdk` | `{load?}` → `{ready, version, error, loading}`; `load` fetches the SDK when missing |
| `sessions.list` | `{dir?, limit?, offset?}` → session infos |
| `sessions.info` | `{session_id, dir?}` → a session info or null |
| `sessions.messages` | `{session_id, dir?, limit?, offset?, include_system?}` → transcript entries of the current chain |
| `subagents.list` | `{session_id, dir?}` → agent ids |
| `subagents.messages` | `{session_id, agent_id, dir?, limit?, offset?}` → transcript entries |

Live sessions (protocol 2). The bridge runs the SDK's `query()` in streaming-input mode, one per handle, with `pathToClaudeCodeExecutable` (the located, verified Claude Code), the session's folder, `includePartialMessages`, `permissionMode: default`, the setting sources the terminal loads (user, project, local) and file checkpointing. It never sets `bypassPermissions`. A handle closes after ten idle minutes, on `session.close`, or when the connection that opened it closes.

| Op | Params → result |
|---|---|
| `session.open` | `{cwd, path_to_cli, resume?, fork?, resume_at?, model?, effort?, permission_mode?, append_system_prompt?, mcp_servers? ({name: {type: 'http', url, headers?}}), env?, persist?}` → `{handle}`. `persist: false` writes no transcript (the command list) |
| `session.send` | `{handle, text, uuid?, images?: [{mime, data}]}` → `{accepted}`; `uuid` becomes the prompt's transcript entry id |
| `session.interrupt` | `{handle}` → `{interrupted}` |
| `session.control` | `{handle, op, args}`: `set_model {model}`, `set_permission_mode {mode: default, plan or acceptEdits}`, `set_max_thinking_tokens {tokens}`, `set_effort {effort}`, `supported_commands`, `supported_models`, `context_usage` (→ `{total_tokens, max_tokens, percentage, model}`), `rewind_files {user_message_id, dry_run?}`, `mcp_status`, `mcp_reconnect {server}`, `mcp_toggle {server, enabled}` |
| `session.close` | `{handle}` → `{closed}` |
| `session.permission_reply` | `{handle, request_id, behavior: allow or deny, updated_input?, message?}` → `{delivered}` |

| Push | Data |
|---|---|
| `session.message` | `{handle, message}`: the SDK message as it is |
| `session.permission` | `{handle, request_id, tool_name, input, tool_use_id, agent_id?, suggestions?, decision_reason?, via: hook or can_use_tool}`: a tool call waiting for Core. Every call passes a PreToolUse hook on its real input; `canUseTool` reuses the answer the hook got for the same call. No answer within 30 minutes is a deny, "No answer from NVX Ancile" |
| `session.state` | `{handle, state: starting, ready, working or closed, session_id?, error?}` |

