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

### Branch, compare, merge

```http
POST /api/v1/messages/msg_01J9ZM…/branch      { "name": "Try a Bayesian framing" }
POST /api/v1/threads/thr_…/compare            { "a": "msg_…head A", "b": "msg_…head B" }
POST /api/v1/merge                            { "picks": ["msg_…", "msg_…"], "strategy": "synthesize", "title": "Best of both" }
```

### Why did the AI say this?

```http
GET /api/v1/messages/msg_01J9ZR…/explain
```

This returns the `Explain` schema: the answering model and every attempt, the memory pack (files, commits, entries), retrieved chunks with scores and whether each was cited, tool calls with their permission outcomes, compaction, usage, and fact-check.

### Compute (proxied to the Controller)

```http
POST /api/v1/compute/nodes/nod_01J9…/actions
Idempotency-Key: 5f1c2e9a-…
{ "action": "start", "idempotency_key": "5f1c2e9a-…" }

→ 202 { "operation_id": "opn_01J9…" }
```

Follow the confirmation chain on `/api/v1/events` (`node.operation`) or `GET /api/v1/compute/operations/:id`.

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
| `POST /mcp/presets/github {token?, read_only?}` | Add the official GitHub MCP server |
