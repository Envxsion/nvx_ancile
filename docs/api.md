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

### One sender at a time

Two Cockpit windows (later a phone) can have one thread open. Each window sends `x-ancile-client: <its own random id>` (8 to 64 letters, digits, `-` or `_`; never a person, never a secret). Every route that starts a turn in a thread (`POST /threads/:id/messages`, `POST /threads/:id/turns`, `POST /messages/:id/regenerate`, `POST /messages/:id/edit` and `POST /claude-code/threads/:id/send`) takes the thread's send lock first, on top of idempotency keys:

- The lock is shared across clients in the database (`core.thread_send_locks`, one row per thread), and taken in one atomic statement.
- A window holds it from the moment it sends until the run its send started is no longer active. The same window sending again is let in, and hears what it always did (`run.already_running` while its turn runs, or the same turn again for a repeated `idempotency_key`).
- Another window gets **409 `thread.busy`**: "Another window is sending in this thread" / "Wait for it to finish, or send as a branch." The Cockpit offers **Send as a branch**: the message waits until that turn ends, then goes from the message the window was answering, as a branch (in a Claude Code thread, a fork of the session). If that turn is paused on a tool approval, the error reads "Waiting for your approval" (`context.reason` is `approval`) and the Cockpit also offers **Deny and send**.
- Nothing has to tidy it up. A send that fails lets go at once; one that crashed before starting a run frees it when its 30-second lease runs out; the run it started ending (however it ends) frees it too.
- A request without the header is a sender of its own.

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

### Answer a group of approvals (Auto mode)

```http
POST /api/v1/approvals/batch
{ "approval_ids": ["apr_01…", "apr_02…"], "decision": "approve", "reason": "fine" }
→ { "items": [{ "approval_id": "apr_01…", "status": "approved" }, { "approval_id": "apr_02…", "status": "missing" }] }
```

Each is answered `once` (`BatchDecisionRequest`); nothing is remembered. An approval that is gone is `missing`; one already answered keeps its status. Auto mode groups its asks with the `approval.batched` run event (`batch_id`, `call_id`, `via`, `reason`) ahead of each `approval.required`; a call it ran by itself leaves an `auto.ran` event (`via`: plan, cache, reviewer or rules), and a call that fits a step of the approved plan leaves `plan.step_ran` (`plan_id`, `step`, its index).

### Auto mode plans

```http
POST /api/v1/auto/plans                         { "thread_id": "thr_…", "summary": "Fix the failing tests", "steps": [{ "action": "shell.exec", "resource": "shell:pnpm test*", "note": "run the tests" }] }  → 201 AutoPlan (proposed)
GET  /api/v1/auto/plans/current?thread_id=thr_… → { "plan": AutoPlan | null }   (or ?run_id=)
GET  /api/v1/auto/plans/apl_…                   → AutoPlan
POST /api/v1/auto/plans/apl_…/decision          { "decision": "approve" | "reject" }  → AutoPlan
```

One plan per thread (or run); a new one supersedes the last. A step without a real literal start is 422 `auto.plan_too_broad`; answering a plan twice is 409 `auto.plan_not_pending`. Changes are `plan.changed` run events when the plan names a run.

```http
POST /api/v1/auto/plans/apl_…/steps   { "action": "shell.exec", "resource": "shell:git push origin fix", "note": "Push the fix" }  → AutoPlan
GET  /api/v1/auto/reviewer            → ReviewerStatus { status: online | offline | unknown, outage_id, reason, local_only, since }
GET  /api/v1/auto/reviewer-check      → ReviewerCheckEstimate { cases, reviewer_calls, est_usd_max, costs_money, … }   (free)
GET  /api/v1/lab/settings              → LabSettings { format_on_edit }
PUT  /api/v1/lab/settings              { format_on_edit? } → LabSettings   (format on edit is off until switched on; the formatter command still goes through the permission gate as shell.exec)
POST /api/v1/auto/reviewer-check      { confirm: true, max_usd? } → ReviewerCheckResult (per category: caught, missed, false alarms)
```

"Add to plan" on a step outside the approved plan (an `approval.batched` event with `out_of_plan: true`): the step is checked like any other (422 `auto.plan_too_broad`); a plan that is no longer the approved one in force is 409 `auto.plan_not_active`. The Cockpit then answers the waiting approval once. `GET /auto/reviewer` says whether a reviewer answers or Auto mode is on its rules alone; changes arrive as the `auto.reviewer` global event.

### Scopes

```http
GET   /api/v1/notebooks/nbk_…/scope          → StoredScope { level, id, private, patch, effective, updated_at }
PATCH /api/v1/notebooks/nbk_…/scope          { "private": true, "network": false, "tools_deny": ["git.push*"] }
GET   /api/v1/threads/thr_…/scope            → StoredScope
PATCH /api/v1/threads/thr_…/scope            { "memory_write": false, "folders": ["/workspace/docs"] }
GET   /api/v1/threads/thr_…/scope/effective  → EffectiveScope { scope, provenance, private, clamped }
```

Decision models (docs/decisions.md): the routes and their state, the free allowance meters, recent receipts and the settings. No key is ever in an answer.

```http
GET /api/v1/decisions            → DecisionStatus (the permission decision log is `GET /permissions/decisions?limit=`) { settings, routes, meters, recent, local_available }
PUT /api/v1/decisions/settings   { "free_first": true, "disabled": ["openai_luna"], "local": { "url": "http://localhost:30000", "model": "Cloudflare/clef-flash" } }   → DecisionStatus
```

Private notebooks' extras live in one policy (docs/privacy.md):

```http
GET /api/v1/privacy/policy   → { policy: PrivacyPolicy, rows: PrivacyRow[] }
PUT /api/v1/privacy/policy   { "policy": { "passive_memory": { "allowed_in_private": true } } }   → the same as GET
```

`StoredScope.shared_before_local` lists, newest first, each time this notebook (or, for a thread, the thread or its notebook) stopped letting data leave the machine, with what had already left: `{ change: private | local_only, changed_at, turns, first_at, last_at, destinations: [{ destination, turns }] }`. Destinations are a closed set (`claude_code`, `anthropic`, `openai`, `google`, `openrouter`, `mistral`, `groq`, `deepseek`, `xai`, `other_cloud`); no content and no model ids.

Tool presets are named sets of tool rules a notebook or thread can choose with `tool_preset` (docs/scopes.md, Tool presets):

```http
GET    /api/v1/tool-presets             → { presets: ToolPreset[] }  (built-in first: research, coding, read_only)
POST   /api/v1/tool-presets             { "name": "Docs only", "tools_allow": ["fs.read", "knowledge.*"], "network": false } → 201 ToolPreset
PATCH  /api/v1/tool-presets/tp_…        { "tools_deny": ["fs.delete"] } → ToolPreset
DELETE /api/v1/tool-presets/tp_…        → 204
PATCH  /api/v1/notebooks/nbk_…/scope    { "tool_preset": "read_only" }
```

A built-in preset cannot be changed or deleted (409 `tool_preset.builtin`); a preset a notebook or thread still uses cannot be deleted (409 `tool_preset.in_use`); choosing one that does not exist is 422 `tool_preset.not_found`. `EffectiveScope.tool_presets` lists every preset in force with the level that chose it.

A field sent as `null` goes back to inheriting. A thread PATCH that would widen its notebook is 422 `scope.widen`; a private notebook refuses cloud engines and data leaving the machine (422 `scope.private_conflict`). `provenance` names the level behind each field (`default`, `private`, `notebook`, `thread`). The Why view (`GET /messages/:id/explain`) carries the thread's `scope`, and each tool decision its `rule` and, for a scope rule, the level that set it. See docs/scopes.md.

### Notebook merge and context links

See docs/notebooks.md.

```http
GET  /api/v1/notebooks/nbk_A/merge-preview?from=nbk_B  → NotebookMergePreview (changes nothing)
POST /api/v1/notebooks/nbk_A/merge   { "from_id": "nbk_B", "instructions": { "choice": "into" | "from" } }
POST /api/v1/notebooks/nbk_A/merge   { "from_id": "nbk_B", "instructions": { "choice": "combined", "instructions": "…", "persona": "…" } }
                                     → 201 NotebookMerge { id, from_title, merged_at, undo_until, can_undo, counts, scope_narrowed }
GET  /api/v1/notebooks/nbk_A/merges  → { items: NotebookMerge[] }  (into or out of this notebook, newest first)
POST /api/v1/notebook-merges/nbm_…/undo → NotebookMerge (undone_at set)

GET    /api/v1/threads/thr_…/links     → ContextLinkList { outgoing, incoming }
POST   /api/v1/threads/thr_…/links     { "to_kind": "notebook", "to_id": "nbk_…" } → 201 ContextLink
GET    /api/v1/notebooks/nbk_…/links   → ContextLinkList
POST   /api/v1/notebooks/nbk_…/links   { "to_kind": "thread", "to_id": "thr_…" } → 201 ContextLink
DELETE /api/v1/context-links/lnk_…     → 204
```

A link to a notebook reads its sources (`kind: sources`); a link to a thread sees its summary (`kind: summary`). Each `ContextLink` carries `status`: `{ ok: true }`, or `{ ok: false, code, reason }` when a scope refuses a read now. Making a link the scopes refuse is 403 with the scope's own code (`scope.private_notebook`, `scope.data_stays_local`, `scope.context_links_off`, `scope.engine_not_allowed`, `scope.model_not_allowed`).

An answer's provenance and the Why view (`GET /messages/:id/explain`) carry `links: ExplainLink[]` (`link_id, kind: sources | summary | pack, via: thread | notebook, to_kind, to_id, title, state: used | empty | refused, passages, cited, code, reason`). A passage read through a link carries `retrieval.hits[].via { link_id, notebook_id, notebook_title }`, and its `citation_ref` part `notebook_id` and `notebook_title`. `retrieval.notebook_id` is null for a thread outside any notebook that read through links.

Context packs (Pro, feature `context_packs`; 402 `pro.feature_required` in the free build):

```http
GET    /api/v1/pro/context-packs                    → { items: ContextPack[] }
POST   /api/v1/pro/context-packs                    { from: { kind, id }, name, source_ids?, note_ids?, summary_thread_id?, memory_entry_ids?, instructions_from? } → 201 ContextPack
GET    /api/v1/pro/context-packs/cpk_…              → ContextPack
DELETE /api/v1/pro/context-packs/cpk_…              → 204
POST   /api/v1/pro/context-packs/cpk_…/attach       { target: { kind: thread | notebook, id } } → ContextPack (403 with a scope code when refused)
POST   /api/v1/pro/context-packs/cpk_…/detach       { target } → ContextPack
GET    /api/v1/pro/context-packs/cpk_…/export       → PackFile { manifest, items, signature }
POST   /api/v1/pro/context-packs/import/preview     { file } → PackImportPreview { manifest, verified, own_key, fingerprint, problems }
POST   /api/v1/pro/context-packs/import             { file, notebook_id? } → 201 ContextPack
```

Steering a running answer (Pro, feature `steer`; 402 `pro.feature_required` in the free build). While a model works through its tool loop, a note reaches it at the next step boundary as a user note it can read, instead of waiting for the answer to end:

```http
GET    /api/v1/pro/steer/can?thread_id=thr_…  → { steerable, why?: no_turn | flow | engine, words? }
POST   /api/v1/pro/steer                       { thread_id, text, after? } → 201 { id, state: pending }
GET    /api/v1/pro/steer/stn_…                → { id, state: pending | applied | expired | cancelled, round? }
DELETE /api/v1/pro/steer/stn_…                → { cancelled, state }
```

`after` is the answer the message was written under: a different one is `409 steer.branch_changed`. A note is `applied` when a model round takes it (the answer's provenance records `steered: [{id, text, round, at}]`), and `expired` when the turn ended first or Core restarted: the Cockpit then sends it as an ordinary message. A flow, and Claude Code as a model, cannot take a note (`409 steer.not_supported`); up to 3 notes wait at once, each up to 4,000 characters (`steer.too_many`, `steer.too_long`). The request is built with the note quoted as data, at the end, so the cached start of the prompt is unchanged.

Word and PDF export (Pro, feature `export_docs`; 402 `pro.feature_required` in the free build). Core builds the file and answers with it as base64; nothing is stored:

```http
GET  /api/v1/pro/export/branches?thread_id=thr_…  → { head_id, branches: [{ head_id, label, messages, created_at, current }] }
POST /api/v1/pro/export  { thread_id, format: docx | pdf, head_id?, compare_with?, options?: { thinking, steps, receipts, sources, appendix } } → { name, mime, bytes, data, private, notes, pages? }
```

`head_id` is the message the branch on screen ends at (default: the thread's current branch). `compare_with` is another branch end: the file then compares the two from where they split (a summary table, the answers side by side, how much of their wording they share). `appendix` (default on) adds the evidence appendix: each answer's cited sources with the stored passage and a SHA-256 fingerprint, a source removed since marked as removed, tool steps counted by tool with the first 60 listed, and receipts. Images are embedded (PNG and JPEG) in a single branch's file, up to 20 and 40 MB; the PDF draws Western European text and shows other characters as `?` (`notes` says how many), while the Word file keeps all of Unicode. A thread in a private notebook exports with a line at the top saying so, and `private: true`. `404 export.branch_missing`, `422 export.nothing`, `422 export.same_branch`, `413 export.too_large`.

### Bulk thread actions, the Trash and read state

```
POST /api/v1/threads/bulk       { "action": "move", "ids": ["thr_…"], "notebook_id": "nbk_…" | null }
                                { "action": "archive" | "unarchive" | "delete" | "restore", "ids": [...] }
                                { "action": "revert", "states": [ThreadState, ...] }
                                → { done: ThreadState[], skipped: [{ id, title, reason, hint }] }
GET  /api/v1/threads/trash      → { items: [{ id, title, notebook_id, deleted_at, purge_at }], retention_days: 30 }
POST /api/v1/threads/trash/empty { "confirm": true } → { purged, kept }
POST /api/v1/threads/thr_…/seen → 204
```

`done` holds the state each changed thread had **before** (notebook, archive, pin, `updated_at`, deleted). Sending those back as a `revert` is Undo, and it restores exactly: moves and archives never touch `updated_at`, so a thread keeps its place in the list. A thread with a run in progress is never changed; it comes back in `skipped` with `reason: "running"`. `refused` means a rule said no (a Claude Code thread cannot enter a private notebook); `missing` means it is gone or already in the Trash. Up to 500 ids. `DELETE /threads/:id` is the same as a one-thread `delete`: the thread leaves every list and route, is kept 30 days, and comes back whole with `restore`. A daily pass (and `trash/empty`, which needs `confirm: true` or answers `trash.confirm_needed`) removes threads past 30 days for good, with their messages, runs and images, and does nothing while any run is active. A thread's own flows become workspace drafts only then.

Threads in `GET /threads` carry `waiting` (a run waits on an approval) and `unread` (an answer arrived since `seen_at`). `POST /threads/:id/seen` sets `seen_at`, so every device agrees.

### Source details

`PATCH /api/v1/sources/:id` takes `title`, `tags` (up to 40 of 60 characters), `author` (up to 200), `published_on` (`YYYY-MM-DD`) and `language` (two letters). Null clears a field and an absent field is left alone. A language set by hand is kept when the source is fetched again; clearing it hands the choice back to detection. Sources carry `author` and `published_on` beside `tags` and `language`.

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
GET    /api/v1/models/watch → ModelWatchReport (providers, lines, models, changes; docs/models.md, Staying current)
POST   /api/v1/models/watch/check { "provider"?: "anthropic" } → ModelWatchReport (429 models.check_too_soon within a minute)
PUT    /api/v1/models/watch/settings { "openrouter_prices": true } → ModelWatchReport
POST   /api/v1/models/watch/seen { "ids": ["mchg_…"] } → 204
POST   /api/v1/models/watch/add { "model_id": "anthropic/claude-opus-5-6" } → 201, the model (404 if the watch has not seen it)
PUT    /api/v1/models/lines/anthropic/opus { "follow"?: true, "use"?: "<model id of that line>" } → ModelLine (400 models.line_model_not_in_line)
POST   /api/v1/models/lines/anthropic/opus/back → ModelLine (409 models.line_no_previous)
```

`PatchModelRequest` also takes `family`, `max_output`, `capabilities`, `price`, and for OpenAI-compatible models `base_url`, `api_key` (replace the key) or `secret` (a stored key's name; `null` for none). A model from `config/models.yaml` takes only `enabled` and `hue` (`hue: null` follows the family).

### Download a local model

Contracts in `packages/contracts/src/localmodels.ts`; the list is `config/local-models.yaml`.

```http
GET  /api/v1/local-models                          → LocalModelsView { hardware, ollama, items: [… fit, installed, model_id, download] }
POST /api/v1/local-models/<id>/download { "anyway": false } → 202 LocalDownload (resumes after a cancel or a failure)
GET  /api/v1/local-models/downloads/<download id>  → LocalDownload { status, completed, total, step, resumed, model_id, error }
POST /api/v1/local-models/downloads/<download id>/cancel → LocalDownload
```

`fit.verdict` is `good`, `slow` (on the processor, or only just), `no` (`blocker: disk | memory`) or `unknown` (Ollama on another computer), with plain `reasons`. A download refuses `local_model.ollama_missing` (409), `local_model.no_disk` (507, never overridden) and `local_model.too_big` (422, unless `anyway`). Chat models come through Ollama's `/api/pull`; done means Ollama's `/api/show` knows the model, which is then switched on, or added as `ollama/<tag>`, in every picker. The embedder comes through Knowledge's `/kn/v1/embeddings/prepare`.

### Loaded models, shown models and OCR

```http
GET  /api/v1/local-models/loaded                → LoadedModelsView { state: ok|unreachable|too_old, items: [{ name, model_id, size_bytes, expires_at, keep_loaded, managed }], memory_bytes, crowded }
POST /api/v1/local-models/loaded/unload { name }       → LoadedModelsView
POST /api/v1/local-models/loaded/keep { name, keep }   → LoadedModelsView
POST /api/v1/local-models/warm { model }               → WarmResult { state: loading|loaded|skipped, note }
POST /api/v1/models/shown { id, shown }                → ModelInfo (Admin → Models, Add more models)
GET  /api/v1/knowledge/ocr                             → OcrView { enabled, language, installed: { rapidocr, tesseract } }
PUT  /api/v1/knowledge/ocr { enabled, language }       → OcrView
POST /api/v1/sources/<id>/ocr                          → Source (read a scanned PDF with OCR, whatever the setting says)
GET  /api/v1/pro/messages/<id>/shadow                   → ShadowOutcome (Pro, Flow lab; 402 in the free build)
GET    /api/v1/pro/smart-sections                   → { items: SmartSection[] }   (Pro, per person; 402 in the free build)
POST   /api/v1/pro/smart-sections                   { name, filter } → 201 SmartSection { id: sec_…, name, filter, position, created_at }
PATCH  /api/v1/pro/smart-sections/sec_…             { name?, filter? } → SmartSection
DELETE /api/v1/pro/smart-sections/sec_…             → 204
GET    /api/v1/pro/smart-sections/sec_…/threads     → { section, threads: [{id, title, updated_at}], total, capped, empty, cap }   (the matching threads, newest activity first, at most 500)
POST   /api/v1/pro/smart-sections/preview           { filter } → the same, without saving
                                                    filter: { engine?: gateway | claude_code | lab, days?, cost_over? (USD, a thread's total), notebook?, model?, title? }
```

Contracts in `localmodels.ts`, `api.ts`, `knowledge.ts` and `flows.ts`. `unload` and `keep` refuse a model NVX Ancile does not list with `local_model.not_managed` (409).

### Chat imports

Contracts in `packages/contracts/src/chatimport.ts`.

```http
POST /api/v1/imports/chats          multipart: file (conversations.json or the export's .zip), notebook_id? → 202 ChatImport
GET  /api/v1/imports/chats          → { items: [ChatImport] }  newest first
GET  /api/v1/imports/chats/<id>     → ChatImport { status, total, done, imported, duplicates, empty, messages, error }
POST /api/v1/imports/chats/<id>/cancel → ChatImport
```

ChatGPT, Claude and Open WebUI exports are read as they come: the branch you ended on, user and assistant text only. The file is kept in `<data>/imports` while the job runs, so a restart carries on from the conversation it reached. A conversation is recognised by the tool's own id and never brought in twice. Files up to 300 MB; `import.too_large`, `import.unreadable`, `import.unknown_format`, `import.empty`, `import.zip_no_chats`.

### Memory: export and import

Contracts in `packages/contracts/src/memory.ts`.

```http
GET  /api/v1/memory/export/plan                      → MemoryExportPlan { files, entries, notebooks: [{ id, title, path, exists, private }] }
GET  /api/v1/memory/export?format=zip|bundle|markdown[&notebook=<id>][&private=leave_out] → the file, as a download
POST /api/v1/memory/imports/preview  MemoryImportRequest → MemoryImportPreview (writes nothing)
POST /api/v1/memory/imports          MemoryImportRequest { …, include: [0, 2] } → 201 MemoryImportView
GET  /api/v1/memory/imports                          → MemoryImportList
GET  /api/v1/memory/imports/<id>                     → MemoryImportView
POST /api/v1/memory/imports/<id>/decide { "accept": "all" | ["mpr_…"], "reject": "rest" | ["mpr_…"], "edits": { "mpr_…": "text" } } → MemoryImportDecisionResult
```

`MemoryImportRequest` is `{ origin: ancile | claude_code | chatgpt | markdown, filename?, text? | data_base64?, target: { kind: user | agents | notebook, notebook_id? } }`. An NVX Ancile export (zip, bundle or Markdown) keeps its own paths; the others go to `target`. Proposals from an import have `kind: imported`, `provenance: import` and `import_id`; they are left out of `GET /memory/proposals`. Accepted entries go into one commit (`memory(import): N entries from <label>`, trailer `Ancile-Import: mim_…`), so undoing any one of them (`POST /memory/proposals/<id> {decision: "undo"}`) reverts them all. A bundle cannot leave private notebooks out (`422 memory.export_bundle_whole`). `{decision: "undo"}` on a turned-down suggestion puts it back to waiting (nothing was written, so nothing is reverted); the inbox's bulk bar uses it for its one Undo.

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

Context: `GET /threads/:id/context-budget?head=&model=` answers `PathBudget`: the branch's estimated tokens for the model that would answer, `ratio` of its window, `level`, and `warn_at` (0.8: the meter warns and offers Compact now) and `compacts_at` (0.95: compacted by itself before sending). A Claude Code thread uses Claude Code's own count instead (`/claude-code/threads/:id/live`).

### Usage

`GET /api/v1/usage?range=day|week|month&tz=Europe/London` answers `UsageReport` (`packages/contracts/src/usage.ts`): totals of tokens in, out and from cache, recorded cost and answers, over today (by hour) or the last 7 or 30 days (by day), cut at midnight in `tz` (an IANA zone; UTC when absent; 400 when unknown). `series` has every bucket, empty ones included, with tokens per engine; `by_engine` splits `gateway` (chat and flows), `claude_code`, `lab` and `other`; `by_model` lists the six busiest models and folds the rest into one row with `model_id: null`. `by_purpose` says what the spend was for: `chat` (answers kept on a message) and every other model call Ancile made, each counted once when it finishes (`factcheck`, `memory`, `decision`, `permission`, `title`, `compare`, `thread`, `web`, `knowledge`, `other`), with `calls` as well as tokens and cost; `totals` and the spend caps include them, `answers` counts chat answers only. A call stopped before its provider reported usage leaves no row. `estimated_cost_usd` is the part of the cost that is Claude Code's own estimate at API list prices, not a bill. GPU compute is the Controller's month (`GET /compute/costs`).

Claude Code's plan figures are also kept over time in `core.plan_limit_samples` (a sample when a window's share changes, or hourly), and engine context records (`provenance.engine_context`) carry `full_tokens`, the whole path's size, since track E. Pro's Engine insights read both.

### Engine insights (Pro)

`GET /api/v1/pro/insights/engines?days=7|30|90[&notebook_id=]` answers `proai.EngineInsightsReport`: `uses` (engine and model, local or not, answers, tokens, cost, purposes, top notebooks), `cost` (daily series by notebook, notebooks, dearest threads), `headroom` (each plan window's daily peak and trend), `context` (tokens sent, the full history's size, saved, saved share and dollars) and `suggestions` (a closed list of kinds). The free build answers it, and `GET /api/v1/pro/insights`, with `402 pro.feature_required` (`PRO_SEAM_ROUTES` in `packages/contracts/src/pro.ts`).

### Start-up, backups and Pro's data

Contracts in `packages/contracts/src/system.ts`.

- `GET /api/v1/system/startup` answers `StartupStatus`: `running`, or `stopped` with the error that stopped Core before it opened the database (`system.database_newer`, `system.backup_failed`, `system.disk_full`, `system.migration_failed`), the `actions` that fit, every backup, the one it suggests restoring, and the backups folder. While stopped, Core answers every other `/api/v1` route with that same error.
- While stopped: `POST /api/v1/system/startup/restore {backup}` (a name from the list; a safety backup of what is there now is taken first), `POST /api/v1/system/startup/retry`, and `POST /api/v1/system/startup/continue-without-backup` (only after `system.backup_failed`; the next start updates once without a backup). Each answers `{restarting}`: true when the desktop app starts every service again.
- Restore from the setup step (staged, because a restore replaces the whole database): `GET /api/v1/system/restore` answers `StagedRestoreState` (the marker in `<data>/backups/restore-staged.json`, and whether Core restarts itself), `POST /api/v1/system/restore/stage {backup}` only chooses (nothing changes), `DELETE /api/v1/system/restore` drops the choice (not while it is applied), and `POST /api/v1/system/restore/apply` asks for the restart (`{restore, restarting}`). At the next start Core applies it before opening the database and answers `system.restoring` on every route; `GET /system/startup` carries the marker as `restore` (`state`, `step`, `attempts`, `safety`, `error`). A restore a restart interrupted starts again from the marker and does not take a second safety copy. Backups are not encrypted, so no passphrase is involved.
- `GET /api/v1/system/backups` answers `BackupList`; `POST /api/v1/system/backups` takes one now (`reason: "manual"`).
- `POST /internal/v1/desktop/backup {reason: "before-downgrade"}` (service token): the desktop app before it installs an older build.
- `GET /api/v1/system/pro-data` answers `ProDataSummary` (each table in the `pro` schema and its rows); `GET /api/v1/system/pro-data/export` answers `ProDataExport`, every row as JSON (bytes as base64), as a download. Both work in the free build and with a lapsed licence: Pro's data is never locked away or deleted.

### The desktop app

Contracts in `packages/contracts/src/desktop.ts` (and `license.ts` for the update offer). The Cockpit has no native access, so the desktop shell and the Cockpit meet in Core (`services/core/src/system/desktop.ts`).

- `GET /api/v1/system/desktop` answers `DesktopState`: `close` (`ask`, `tray` or `quit`: what closing the window does), `hidden`, `warming` (services still starting after the window opened), `last_update` (from, to and notes of the last update, for the one-time "What changed" sheet) and `pro` (the desktop extras are on). `PUT` takes `{close}`.
- `POST /api/v1/system/desktop/command {command}` (`quit`, `update.check`, `update.restart_now`, `update.on_quit`, `update.tonight`, `update.cancel`, `update.go_back`) queues a command for the shell; answers 202. `update.go_back` answers `402 pro.feature_required` (feature `desktop`) without Pro.
- `GET /api/v1/system/updates` answers `{channel, beta_available}`; `PUT` takes `{channel}`. `beta` answers `402 pro.feature_required` without Pro, and a lapsed Pro install is given `stable`.
- `GET /api/v1/system/update-offer` answers the update on offer with `notes`, `size_bytes`, `state` (`available`, `downloading`, `ready`, `waiting`, `installing`, `failed`), `progress`, `when` (`none`, `quit`, `tonight`), `scheduled_for`, `error` and `previous_version`.
- `GET /internal/v1/desktop/poll?after=<seq>` (service token; `counts=1` for the numbers only) answers `DesktopPoll`: the notifications to show (an approval waiting, a run of 30 seconds or more, a notice in a category set to Desktop; a private notebook gives no body), the commands, the close choice, how many runs are working and approvals waiting, and `background` (Pro). `PUT /internal/v1/desktop/close`, `POST /internal/v1/desktop/window {visible, focused, warming}`, `POST /internal/v1/desktop/updated {from, to, notes}` and `POST /internal/v1/desktop/update-offer` are the shell's other calls.
- `POST /internal/v1/desktop/approval-action {approval_id, action}` (service token, Pro): a button on a notification. Refused with `402 pro.feature_required` in the free build, `403 desktop.critical_in_app` for a critical request and `409 desktop.already_answered`; otherwise answered once, on the exact request, leaving no grant.
- Pro: `GET /api/v1/pro/desktop/links` answers `{allowed}`; `POST` and `DELETE /api/v1/pro/desktop/links/allow` record and withdraw the yes to "Allow links from this app".

### Why did the AI say this?

```http
GET /api/v1/messages/msg_01J9ZR…/explain
```

This returns the `Explain` schema: the answering model and every attempt, the memory pack (files, commits, entries), retrieved chunks with scores and whether each was cited, tool calls with their permission outcomes, compaction, usage, and fact-check. `origin` says where it was written: `ancile`, `claude_code_live` (a Claude Code turn sent from NVX Ancile), or `claude_code_import` (written by Claude Code in a terminal and brought in from its transcript, so there is no retrieval or citation record; the Why panel says "Written before import, no citation record").

### Citations after a source is removed or changed

```http
GET /api/v1/messages/msg_01J9ZR…/citations
```

Answers `CitationStatus` (`packages/contracts/src/knowledge.ts`): each `citation_ref` of the answer with `state` `current`, `changed` (the source was read again and the passage is gone or different), `removed` (deleted or merged away, with `removed_at` and `merged_into`) or `unknown` (could not be checked). Deleting (`DELETE /sources/:id`) or merging away (`POST /sources/merge`) a source records a tombstone in `core.source_tombstones` first. `GET /messages/:id/factcheck` carries `previous`: the check before the newest, its score and summary, and `sources_changed`, `removed`, `changed` and a `note` in words.

### Checking a highlighted claim

```http
POST /api/v1/messages/msg_01J9ZR…/selection-checks
{ "text": "Error code E-17 means the impeller is blocked.", "kind": "prose", "web": false, "again": false }
```

Answers `{ check, cached }` (`SelectionCheck`, `packages/contracts/src/factcheck.ts`) after one model call, or the plain error: `routing.no_chat_model`, `factcheck.judge_not_allowed`, `factcheck.still_writing`, `factcheck.selection_too_long`. `check` has the `verdict` (`holds`, `partly`, `doesnt_hold`, `cant_tell`), a one-line `headline`, the `corrected` claim, up to five `evidence` lines (each with `origin` `source`, `web`, `run` or `model`, and its `source`), one `closing` line, who checked (`checker_model_id`, `checker_family`), `cost_usd` and `billed` (`key`, `plan`, `free`), what the web did (`web.used`, `web.note`) and what the sandbox did (`ran`). It is recorded on the message (`provenance.selection_checks`) and returned by `GET /messages/:id/selection-checks` and in `GET /messages/:id/explain` as `selection_checks`. `POST /messages/:id/factcheck` takes an optional `{ web?, critical?, models?, again? }` (`critical` checks in mission-critical mode for this answer, `models` is your pick of checkers, `again` skips the verdict cache) and answers `202 { factcheck_id, run_id, stream_url, web: { used, note } }`, or `200 { needs_choice }` (`FactcheckNeedsChoice`: every ready chat model with its tier, a `suggested` pair, the `floor`) when a critical check cannot find two independent standard-or-frontier checkers and nothing was started. Each claim carries `check` (`tier_used`, `model_id`, `escalated_from`, `cached`, `degraded`, `general_knowledge`), and the check carries `critical`. `GET /notebooks/:id/verdict-cache` answers `VerdictCacheState` (`scope`, `entries`, `can_share`, `share_note`); `POST /notebooks/:id/verdict-cache {shared}` moves the notebook's source-free verdicts to the global cache or back (`privacy.denied` in a private notebook unless Settings → Private notebooks allows it). A notebook's `critical` and `share_checks` are on `Notebook`; `critical` is patchable. `PATCH /models/:id {tier}` pins a model's tier (null works it out again) and `GET /models` carries `tier`, `tier_label` (the same tier as frontier, standard, small or tiny) and `tier_source`; the run's stream carries `factcheck.claim` events (a claim found, a verdict landed).

### Languages in a notebook

`GET /api/v1/notebooks/:id/languages` answers `NotebookLanguages`: the languages of the notebook's ready sources (ISO 639-1, detected at ingest), whether they are `mixed`, the embedder and whether it is multilingual, and `multilingual_option` (the model to switch to; null when the embedder already is one).

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

### Activity

Read-only (docs/activity.md). Nothing here starts, stops or signals anything.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/activity` | | `ActivityResponse`: `items[]` (closed shape: `id`, `kind` run, claude_session, subagent or shell, `title`, `detail`, `state` running, waiting, finished, failed or stopped, times, `thread_id`, `thread_title`, `message_id`, run `run_kind`, `run_status`, `progress {done,total}`, Claude Code `session_id`, `project`, `held` terminal or recent), `running`, `import` (the background import's progress or null), `at` |
| POST | `/activity/typing` | `{ ms? }` (0 to 10,000) | 204. The person is typing: a background import of Claude Code sessions waits. The Cockpit sends it only while an import runs, at most every 1.5 s, and never what was typed |

## Core ↔ Knowledge (`/kn/v1`)

Internal, bearer `ANCILE_SERVICE_TOKEN`.

```http
POST /kn/v1/search
{ "query": "dropout rate", "notebook_ids": ["nbk_…"], "k": 12, "mode": "hybrid", "rerank": true }

→ { "items": [ { "chunk_id": "chk_…", "source_id": "src_…", "title": "Trial B final report",
                 "text": "…", "context_blurb": "…", "score": 0.031, "rerank_score": 0.92,
                 "char_start": 18231, "char_end": 18902, "page": 14, "heading_path": ["Results","Attrition"] } ] }
```

`POST /kn/v1/passages/check` takes `{ workspace_id, items: [{ ref, source_id, text_sha256 }] }` (up to 500) and answers each with `state` `current`, `changed` or `removed`, the source's title and `deleted_at`. A passage is current when its chunk is in the source's current version with the same hash, or when the same text moved to another chunk. `GET /kn/v1/notebooks/{id}/languages` answers `NotebookLanguages`. Each `Source` carries `language`.

```http
GET  /kn/v1/embeddings         → EmbeddingStatus { active_model_key, configured_model_key, reembed: { status, done, total, percent, … } }
POST /kn/v1/embeddings/check   → EmbeddingStatus (look for a changed embedding model now)
```

Notebook merge (docs/notebooks.md), Core only:

```http
GET  /kn/v1/notebooks/{into}/merge-preview?from={from}&workspace_id=  → KnMergePreview { move, already, duplicates, versions }
POST /kn/v1/notebooks/{into}/merge       { from_id, workspace_id } → KnMergeRecord { moved, already, merged }
POST /kn/v1/notebooks/{into}/merge/undo  { from_id, workspace_id, record } → { restored }
```

Core serves both to the Cockpit as `GET /api/v1/knowledge/embeddings` and `POST /api/v1/knowledge/embeddings/check`. See docs/configuration.md (Changing the embedding model).

```http
GET  /kn/v1/embeddings/local?model=BAAI/bge-small-en-v1.5  → { model, installed, downloadable } (never downloads)
POST /kn/v1/embeddings/prepare { "model": "BAAI/bge-small-en-v1.5" } → { model_key, dim } (fastembed's own download; 409 embed.download_off)
```

Core's one-click local models use these for the embedder.

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
| `GET /mcp/presets` | `{items: McpPreset[]}`: the Add server list, each with its fields, whether its runtime (Node or uv) is installed (`available`, `missing` in words) and whether it is `added` |
| `POST /mcp/presets/:id/add` (AddMcpPresetRequest) | 201 with the server after its first connection attempt (`status`, `last_error`); secret fields go to the encrypted store and never come back |
| `PATCH /mcp/servers/:id/tools/:tool` (UpdateMcpToolRequest) | Tier (`null` goes back to the server's own) or switch a tool off; applied at once |
| `GET /mcp/approvals` | `{items: McpToolApproval[]}`: each server's approved tool list, NVX Ancile's host and Claude Code's own, with `state` and the `diff` when changed |
| `POST /mcp/approvals/:key/approve` (ApproveMcpToolsRequest `{fingerprint}`) | Approve the list a changed server offers now. `key` is `host:<name>` or `claude_code:<name>`. A fingerprint that is no longer current is 409 `mcp.tools_changed_again` |

Secret values are never returned: a secret is `{key, set}`. Changes are published as `mcp.server_changed`. A server's view carries `approval` (its McpToolApproval), and a tool held back since its server changed has `held: true`. Tool-list changes are published as `mcp.tools_changed`.

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

## Files (the code editor)

Under `/api/v1` (packages/contracts/src/files.ts). Only the workspace (labs included), registered repositories and Claude Code project folders are reachable; paths are resolved with symlinks followed and must stay inside one of them.

| Route | Does |
|---|---|
| `GET /files?path=&thread_id=` | Read one file (up to 2 MB): `{path, name, root {kind, path, label}, content, bytes, sha256, modified_at, binary}`. Runs the gate as `fs.read` (principal `person:editor`); only a refusal stops it |
| `PUT /files {path, content, base_sha256, thread_id?, confirmed?}` | Save it. Runs the gate as `fs.write` on the real path. A refusal is `files.write_denied`; an ask is `409 files.needs_confirm` until the person sends `confirmed: true`, which is logged as an approved decision. A `base_sha256` that is not the file on disk is `409 files.changed`. Written to a temporary file, then renamed over the target |

## Artifacts

Under `/api/v1` (packages/contracts/src/artifacts.ts, docs/artifacts.md). Artifacts are parsed from the answers that wrote them; Core never serves one as a page.

| Route | Does |
|---|---|
| `GET /threads/:id/artifacts` | `{items: [{key, type, title, allow_network, network_changed_at, versions: [{version, message_id, created_at, type, title, language, content, on_path}]}]}`. Every answer on any branch that wrote the same key is a version, oldest first |
| `PUT /threads/:id/artifacts/:key/network {allow}` | Record the person's decision to let one artifact reach the network (https only). Off until this is called. Logged |

## Code interpreter

Under `/api/v1` (packages/contracts/src/interpreter.ts, docs/interpreter.md). `python_run` is a built-in tool (action `code.run`); these routes are for the Cockpit window that runs it.

| Route | Does |
|---|---|
| `GET /interpreter/status` | `{version, cached_bytes, ready, downloading}` for the Python runtime |
| `GET /interpreter/runtime/:version/:file` | One runtime file or allow-listed package, downloaded on first use and served only after its pinned SHA-256 matched. `pyodide-lock.json` lists only the allowed packages |
| `POST /interpreter/requests/:id/claim {client_id}` | Take a request announced by the global event `interpreter.requested`; the first window wins (`409 interpreter.claimed` after), and gets `InterpreterRequest` |
| `POST /interpreter/requests/:id/result` | The claiming window's `InterpreterOutcome` (stdout, stderr, PNG figures, error, duration). Figures are stored and named by id in the tool result |
| `GET /interpreter/figures/:id` | A stored figure, `image/png` with `nosniff` and a sandboxing CSP |

## Images

Under `/api/v1` (packages/contracts/src/images.ts, docs/images.md). `image_generate` is a built-in tool (action `image.generate`); `POST /threads/:id/turns` and `POST /claude-code/threads/:id/send` take `image_ids` (up to 8, images of that thread): `422 image.model_no_vision` when the model answering cannot see images, `404 image.not_found` for an id that is not this thread's.

| Route | Does |
|---|---|
| `GET /images/providers` | `ImageProviders {items, default_id, empty_hint}`: each provider from config/images.yaml with `ready` and, when not, `reason`; `empty_hint` is the one line to show when none is ready |
| `POST /threads/:id/images` | Multipart, the image as `file` (PNG, JPEG, WebP or GIF by its bytes, up to 20 MB; `alt` optional). 201 `ImageRecord`. `413 image.too_large`, `415 image.type_not_allowed` |
| `GET /threads/:id/images` | `{items: ImageRecord[]}`: the thread's images, attached, generated and loaded |
| `GET /images/:id` | The bytes, with `nosniff` and a sandboxing CSP; 404 for an image of another workspace or a deleted thread |
| `GET /threads/:id/image-hosts` | `RemoteImageHosts {remembered_in: notebook \| thread, hosts, allowed}`; `allowed` is false where nothing may leave this machine |
| `POST /threads/:id/image-hosts {host}` | Allow a host's images for the thread's notebook (or the thread). 403 `scope.private_notebook` / `scope.data_stays_local` where nothing may leave |
| `GET /threads/:id/images/remote?url=` | A remote image, fetched by Core only from an allowed host: public addresses only, at most 10 MB, raster types only. `403 image.remote_not_allowed`, `400 image.remote_blocked`, `413 image.too_large`, `502 image.remote_failed` |

## Attachments

Under `/api/v1` (packages/contracts/src/attachments.ts). A file for one message: PDF, text, code or CSV, read when it is attached and kept on the message as a `file` part (`text`, `pages`, `truncated`); never a source, never indexed. `POST /threads/:id/turns` takes `attachment_ids` (up to 5, this thread's): `404 attachment.not_found` for one that is gone, `422 attachment.claude_code` for a Claude Code session, which reads a path. The model reads each file quoted as data, after the question.

| Route | Does |
|---|---|
| `POST /threads/:id/attachments` | Multipart, the file as `file` (up to 25 MB). 201 `AttachmentRecord {id, name, mime, kind: pdf or text, bytes, pages, chars, truncated}`; never the text. A PDF is read by the knowledge service (`POST /kn/v1/attachments/extract`), the same reader as sources; text over 200,000 characters keeps its start (`truncated`). The file waits in memory for an hour. `413 attachment.too_large`, `415 attachment.type_not_allowed`, `422 attachment.unreadable`, `attachment.empty`, `attachment.scanned_pdf` |
| `DELETE /threads/:id/attachments/:att` | 204: forget it |

With Pro (feature `attachment_pages`), `AttachmentRecord` also carries `tokens` (a rough count for the chip), and a message over the model's context budget keeps only its most relevant pages: the `file` part gets `kept {pages, of, unit: page or part, partial?}` and its `text` holds those pages in order, with a line where pages were left out (the Cockpit writes it "Pages 3–7 of 40 kept"). Pages are ranked by relevance to the message words with local arithmetic only: no model is asked and nothing leaves the computer, so a private notebook's file is trimmed the same way. Scanned or blank pages are never kept; one page bigger than the budget is kept in part. A text file is cut into parts of about 3,000 characters and trimmed the same way. Claude Code threads are given a path, so there is nothing to trim. The knowledge reader's `POST /kn/v1/attachments/extract` answers `page_spans` (each page's `[start, end)` in the text) for this.

`PATCH /threads/:id {effort: low, medium, high or null}` sets the thread's reasoning effort (EN1); `GET /models` lists `effort_levels` for each model that takes one (from its provider's profile). Effort is a request setting and not an epoch reason (docs/prompt-caching.md).

## Works with Claude Code

Under `/api/v1` (docs/claude-code.md, shapes in `packages/contracts/src/claudecode.ts`):

| Route | Does |
|---|---|
| `GET /claude-code/status?fresh=1` | `ClaudeCodeStatus`: installed, version, path, sign-in (method and plan only, never the account's email or organisation), install state, `verification` of the install, the Agent SDK's state, settings. Cached for 10 s unless `fresh`. |
| `PATCH /claude-code/settings {auto_install?, auto_import?, exclude_folders?, claude_telemetry?, factcheck_judges?}` | Save and answer `ClaudeCodeSettings`. `factcheck_judges` (1 to 4, default 1) is how many fact-check judge calls Claude Code may answer at once (docs/factcheck.md). Changing `exclude_folders` puts away what came from those folders (threads archived, never deleted; `claude_code.changed {what: sessions}`) |
| `POST /claude-code/install` | 202 `{state, error}`: runs Anthropic's official installer in the background (`claude_code.changed {what: install}` as it goes) |
| `POST /claude-code/sign-in {method?: claudeai, console or sso}` | 202 `{started}`: opens Claude Code's own sign-in (`claude auth login`); NVX Ancile watches `claude auth status` for up to 5 minutes |
| `POST /claude-code/sign-out` | 204: `claude auth logout`, only when the person asks |
| `GET /claude-code/sessions?q=&cwd=&limit=&cursor=` | `{items: ClaudeCodeSession[], next_cursor}`, newest first, across every project; `open_in_terminal` when a Claude Code process outside NVX Ancile holds the session right now |
| `POST /claude-code/sessions/import {session_ids, notebook_id?}` | `ImportClaudeCodeSessionsResult`. Idempotent: an imported session is synced instead |
| `POST /claude-code/threads/:id/sync` | `{thread_id, session_id, added, gone}`: pull what is new; `gone` when the transcript is no longer on this computer (the thread stays) |
| `GET /claude-code/projects` · `PUT /claude-code/projects {cwd, notebook_id}` · `DELETE /claude-code/projects?cwd=` | Folder → notebook bindings (`{items: ClaudeCodeProject[]}`) |
| `POST /claude-code/projects/exclude {cwd}` | "Don't bring in this folder": adds it to `exclude_folders` (unless already covered) and puts away what came from it; answers `ClaudeCodeSettings` |
| `POST /claude-code/threads {cwd, notebook_id?}` (`CreateClaudeCodeThreadRequest`) | 201 `CreateClaudeCodeThreadResult {thread_id, notebook_id, cwd, title}`: a new thread bound to a new Claude Code session in that folder. The session starts with the first turn (sent with `parent_id: null`), which starts it fresh and binds the session Claude Code names. Absent `notebook_id`: the folder's notebook (made or adopted as an import would). 400 `claude_code.folder_invalid` (not a full path, missing, or a file), 409 `claude_code.folder_excluded`, 403 `scope.*` where the notebook does not allow Claude Code, 403 `claude_code.folder_out_of_scope` outside the notebook's allowed folders |
| `POST /claude-code/threads/:id/send` (`SendClaudeCodeRequest`) | 202 `SendClaudeCodeResult {run_id, user_message_id, assistant_message_id, context_shared?}`. One turn in the thread's live session: the user message is written at once (its parent is `parent_id`, else the active head; `null` is the start of the session: editing the first message starts a new session in the same folder, bound to the same thread, as a branch at the root), and `assistant_message_id` is the answer it streams into (removed again if Claude Code writes nothing under the prompt). `effort` is `low`, `medium`, `high`, `xhigh`, `max` or `auto` (no effort sent: Claude Code picks, and a session with one set reopens without it). A run of kind `claude_code` streams the answer on `/runs/:run_id/stream` like any other. A `parent_id` the session already went on from, or `as_branch: true`, forks the session there. `idempotency_key` makes a repeat the same turn. When a Claude Code process outside NVX Ancile (a terminal, an IDE) holds the session, the turn forks it by itself and the result has `branched: "open_in_terminal"`. 409 `claude_code.session_busy` when no such process is seen but Claude Code wrote the session from somewhere else in the last minute (send again with `as_branch`), 409 `claude_code.folder_missing` when the session's folder is not there any more (nothing is sent; see `/folder` below), `run.already_running` while a turn runs, a scope error (`scope.*`, 403) where Claude Code is not allowed. A parent written by another model goes on from Claude Code's latest message on the path, with the other turns as a digest; the result then has `context_shared: true` (docs/engines.md) |
| `POST /claude-code/threads/:id/interrupt` | `{interrupted: true}`: stops the running turn (Claude Code's own interrupt); the run ends `cancelled` and keeps what streamed. Cancelling the run does the same. 409 `claude_code.not_live` when nothing runs |
| `POST /claude-code/threads/:id/model-changed` | `{withdrawn}`: the person chose another model while a turn waits on approvals; each is cancelled (run event `approval.resolved` with `decision: "cancelled"`, and the global `approval.resolved`), and the running turn hears it was withdrawn. Approvals still open when their turn ends are withdrawn the same way, by themselves |
| `POST /claude-code/threads/:id/folder` (`ClaudeCodeFolderRequest`: `{cwd}` or `{without_files: true}`) | `ClaudeCodeFolderResult {cwd, no_files}`: the session's folder moved, was renamed or was deleted. `{cwd}` points the thread at the folder where it is now (checked like a new thread's: 400 `claude_code.folder_invalid`, 409 `claude_code.folder_excluded`, 403 `claude_code.folder_out_of_scope` or `scope.*`); `{without_files: true}` goes on with no folder (an empty folder NVX Ancile keeps, Claude Code's own tools off). Either is kept on the thread (`ThreadSettings.claude_code`: `cwd`, `no_files`, `fresh_next`), and the next turn starts a new session given the thread so far, which becomes the thread's own. 409 `run.already_running` while a turn runs |
| `GET /claude-code/threads/:id/live` | `ClaudeCodeLiveState`: `idle`, `starting`, `ready` or `working`; `locked_elsewhere` (and `open_in_terminal` when a Claude Code process was seen holding it, not only guessed from a recent write); `folder_missing` and `no_files`; the model, effort and permission mode Claude Code reports; the folder; `context` (Claude Code's own count, and `compacts_at`, where it compacts by itself, as a percent) while a session is open |
| `GET /claude-code/plan-limits?refresh=1` | `ClaudeCodePlanLimits` (`packages/contracts/src/usage.ts`): a Claude plan's windows (`five_hour` the session, `seven_day` the week, per-model weekly ones) with `percent` used, `resets_at` and `updated_at`; `available: false` for an API key sign-in. Kept from every `rate_limit_event` a live session reports, and from Claude Code's usage report, asked after a turn at most every 3 minutes, or with `refresh` (at most every 20 seconds; in a session that sends nothing when none is open), and on a plain GET when there are no figures yet (waiting up to 15 seconds) or they are older than 3 minutes. The report's own rows (`rate_limits.limits`, what claude.ai lists) win; codenamed windows are never shown. `claude_code.changed {what: limits}` when they move |
| `GET /claude-code/usage?tz=` | `ClaudeCodeUsage` (`packages/contracts/src/usage.ts`): what NVX Ancile measured from Claude Code's answers here (live sessions and `claude-code/<model>` answers): `today` and `week` totals (tokens in, out, from cache, answers), `days` (the last 7 by local day), `cache_hit_rate` (cached over everything read in the 7 days, null with nothing read), `by_thread` (the 8 busiest threads) and `imported` (of the week, the answers brought in from terminal sessions, already in `week`, with the number of `sessions` they came from). A Claude Code answer counts once, where it lives now: replaced copies and copies in deleted threads are left out (other engines' answers count even after deletion: that spend was real). Not the plan's figures |
| `GET /claude-code/mcp-servers?refresh=1` | `ClaudeCodeMcpServers` (`packages/contracts/src/claudecode.ts`): the MCP servers you have in Claude Code, read-only: `name`, `source` (claudeai, user, project, local, plugin, other), `status` and a `tools` count, never a command, address, env value, header or token. From Claude Code's status report (asked from a session that sends nothing: on first view, when older than 10 minutes, or with `refresh` at most every 20 seconds) and every live session's init message (updates, never removes); with neither, `from: config` and only the names in `~/.claude.json` and `.mcp.json`. `claude_code.changed {what: mcp}` when it moves |
| `POST /claude-code/mcp-servers/:name/use/preview` (UseClaudeCodeMcpRequest) | `ClaudeCodeMcpUsePreview`: what "Use in NVX Ancile" would copy from that server (read with `claude mcp get`): command or address, arguments, plain settings, the names of values that would move to the encrypted store, unresolved `${VAR}`, whether NVX Ancile already has it, and whether Claude Code changed it since the last copy. No secret value is in it |
| `POST /claude-code/mcp-servers/:name/use` (UseClaudeCodeMcpRequest) | 201 with the new `McpServerView`; the same server copied before is returned as it is. claude.ai connectors answer `mcp.not_copyable` |
| `POST /claude-code/mcp-servers` (AddClaudeCodeMcpServerRequest) | 201; adds a server to Claude Code with `claude mcp add-json` (`replace: true` changes one, and puts the old one back if the add fails) |
| `DELETE /claude-code/mcp-servers/:name?scope=user\|project\|local` | 204; `claude mcp remove`. Not for claude.ai connectors or plugin servers |
| `GET /claude-code/threads/:id/commands?wait=` | `ClaudeCodeCommandList {items, partial}`: Claude Code's own "/" list for the session's folder (read from a session that sends nothing and writes no transcript; cached 10 minutes per folder and Claude Code version), merged with what NVX Ancile does itself, one entry per name (the one that says the most) (docs/claude-code.md, Commands). Answers at once: until that folder's list has been read, `items` is the built-ins and `partial` is true while the read goes on in the background (ask again shortly); `wait=1` waits for it. Core reads the lists for the two most recent Claude Code folders 45 s after it starts |

A turn's run events: `model` (display name "Claude Code"), `context.shared` once when some of the thread goes with the prompt (docs/engines.md), `text.delta` and `reasoning.delta` as Claude Code streams, `tool.call` (with the tier the call maps to) and `tool.result` for each tool, `approval.required` when a call needs you, `citation` for each source passage the answer cites, `usage`, then `run.status` and `done` from the run itself. A restart during a turn ends it with a `warning` (`claude_code.recovered`) and brings in what Claude Code wrote from its session.

### Engines: one thread, any model

Under `/api/v1` (docs/engines.md, shapes in `packages/contracts/src/engines.ts`):

| Route | Does |
|---|---|
| `GET /engines` | `EngineList`: each engine (`gateway`, `claude_code`) with `available`, `reason` (in words, when not), `capabilities` (`streaming`, `tools`, `images`, `own_context`, `context_window`) and the `model_prefix` that chooses it |
| `POST /threads/:id/turns` (`SendTurnRequest {text, parent_id?, model?, effort?, source_ids?, as_branch?, task_class?, idempotency_key}`) | 202 `SendTurnResult {run_id, user_message_id, assistant_message_id, engine, model_id, context_notice}` (`assistant_message_id` from Claude Code too; `effort: auto` lets Claude Code pick). The model chooses the engine: in a thread bound to a Claude Code session, no model or `claude-code/<model>` carries the session on; any other model answers through the gateway and the thread keeps its binding; `claude-code/<model>` elsewhere is Claude Code as a model. The thread's scope is checked first (403 `scope.*`, nothing written). `context_notice` is the line to show when some of the thread goes to Claude Code. The answer streams on `/runs/:run_id/stream` |
| `GET /threads/:id/instructions` | `InstructionsView {thread, notebook, effective}`: the thread's own instructions and persona, its notebook's, and the note engines receive |
| `PUT /threads/:id/instructions {instructions?, persona?}` | Save the thread's own (empty clears); answers `InstructionsView` |
| `GET /notebooks/:id/instructions` · `PUT /notebooks/:id/instructions {instructions?, persona?}` | A notebook's `AncileInstructions {instructions, persona}` |

Answers from any engine in a mixed thread record `provenance.engine_context` (`EngineContextReport`). Run event `context.shared {message_id, engine, notice, turns, tokens, seeded_from_summary}`: one line above the answer when a turn sends some of the thread to Claude Code.

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

Live sessions (protocol 2). The bridge runs the SDK's `query()` in streaming-input mode, one per handle, with `pathToClaudeCodeExecutable` (the located, verified Claude Code), the session's folder, `includePartialMessages`, `permissionMode: default`, the setting sources the terminal loads (user, project, local) and file checkpointing. It never sets `bypassPermissions`. A handle closes after ten idle minutes, on `session.close`, or when the connection that opened it closes. Core closes its own live sessions sooner, after `ANCILE_CC_LIVE_IDLE_MS` (3 minutes by default) without a turn, so their Claude Code process lets go of the folder (Windows keeps a folder a process works in locked against renaming or moving); the next turn resumes the session.

| Op | Params → result |
|---|---|
| `session.open` | `{cwd, path_to_cli, resume?, fork?, resume_at?, model?, effort?, permission_mode?, append_system_prompt?, mcp_servers? ({name: {type: 'http', url, headers?}}), env?, persist?}` → `{handle}`. `persist: false` writes no transcript (the command list) |
| `session.send` | `{handle, text, uuid?, images?: [{mime, data}]}` → `{accepted}`; `uuid` becomes the prompt's transcript entry id |
| `session.interrupt` | `{handle}` → `{interrupted}` |
| `session.control` | `{handle, op, args}`: `set_model {model}`, `set_permission_mode {mode: default, plan or acceptEdits}`, `set_max_thinking_tokens {tokens}`, `set_effort {effort}`, `supported_commands`, `supported_models`, `context_usage` (→ `{total_tokens, max_tokens, percentage, model, compacts_at}`; `compacts_at` is where Claude Code compacts by itself, as a percent of the window, or null), `usage` (the SDK's experimental usage report, feature-detected and read loosely: → `{rate_limits_available, subscription_type, windows: {five_hour?, seven_day?, …: {utilization, resets_at}}, model_scoped: [{label, utilization, resets_at}], session_cost_usd}`; `failed` when this SDK has no such method; never the account), `rewind_files {user_message_id, dry_run?}`, `mcp_status`, `mcp_reconnect {server}`, `mcp_toggle {server, enabled}` |
| `session.close` | `{handle}` → `{closed}` |
| `session.permission_reply` | `{handle, request_id, behavior: allow or deny, updated_input?, message?}` → `{delivered}` |

| Push | Data |
|---|---|
| `session.message` | `{handle, message}`: the SDK message as it is |
| `session.permission` | `{handle, request_id, tool_name, input, tool_use_id, agent_id?, suggestions?, decision_reason?, via: hook or can_use_tool}`: a tool call waiting for Core. Every call passes a PreToolUse hook on its real input; `canUseTool` reuses the answer the hook got for the same call. No answer within 30 minutes is a deny, "No answer from NVX Ancile" |
| `session.state` | `{handle, state: starting, ready, working or closed, session_id?, error?}` |

POST /api/v1/lab/init                  { repo_id } → LabInitDraft { path, content, exists, existing_sha256, diff }   (a draft only; saving is PUT /files)
