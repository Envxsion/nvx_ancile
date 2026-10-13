# Events

Ancile streams with server-sent events (SSE) on two channels:

| Stream | URL | What | Persisted |
|---|---|---|---|
| Run stream | `GET /api/v1/runs/:id/stream` | Everything one run does: steps, tokens, tool calls, approvals, fallbacks | Yes, in `run_events` for 7 days after the run ends |
| Global stream | `GET /api/v1/events` | One per tab: notifications, approvals, source progress, health, node operations, suggestions | Recent window only |

Every event has a monotonic `seq` (also sent as the SSE `id`) and an ISO `at`. Reconnect with `Last-Event-ID: <seq>` and the stream replays everything after it. That's why closing the tab mid-answer loses nothing. The schemas are in `packages/contracts/src/events.ts`.

## Run events

| type | Payload | UI |
|---|---|---|
| `run.status` | `status` (queued, running, waiting_approval, waiting_compute, succeeded, failed, cancelled), `detail?` | Mark state, status bar |
| `step.started` / `step.finished` | `step`, `kind`, `label` / `ok`, `ms`, `summary?` | Progress line under the message ("Searching 3 sources…") |
| `memory.injected` | `files[{path, commit, entries, tokens}]`, `truncated` | Why panel |
| `retrieval.done` | `chunks`, `sources`, `ms` | Progress line, then the Why panel |
| `text.delta` | `message_id`, `delta` | Streamed text |
| `reasoning.delta` | `message_id`, `delta` | Collapsible "thinking" |
| `citation` | `message_id`, `part` (citation_ref) | Inline `[n]` markers |
| `tool.call` | `call_id`, `tool`, `args_preview`, `tier` | Tool card |
| `tool.result` | `call_id`, `ok`, `preview` | Tool card result |
| `approval.required` | `approval_id`, `tool`, `action`, `resource`, `tier`, `suggestions[]` | Approval dialog; the mark closes |
| `approval.resolved` | `approval_id`, `decision` (`approved`, `denied`, `expired`, or `cancelled` when withdrawn because its turn ended or the model changed) | Dialog closes; the run resumes |
| `fallback` | `from_model`, `to_model`, `reason`, `detail` | Muted footer note: "answered by X · Y was unavailable" |
| `compute.waiting` | `node_id`, `eta_s`, `can_use_cloud` | "Waking your GPU node · about 80 s", with **Use a cloud model instead** |
| `usage` | `message_id`, `usage` | Footer tokens and cost |
| `context.shared` | `message_id`, `engine`, `notice`, `turns`, `tokens`, `seeded_from_summary` | One line above the answer: some of the thread went to Claude Code (docs/engines.md) |
| `warning` | `code`, `message` | Inline notice |
| `error` | `code`, `title`, `hint`, `attempts[]` | Error block with **Copy debug info** |
| `done` | `message_id` | Stream ends |

## Global events

| type | Payload | UI |
|---|---|---|
| `notification` | `id`, `level`, `title`, `body?`, `action?` | Toast, plus the notification centre |
| `run.updated` | `run_id`, `status`, `thread_id` | Rail badges ("still answering") |
| `approval.requested` / `approval.resolved` | `approval_id`, … | Status bar counter |
| `source.progress` | `source_id`, `status`, `stage`, `done?`, `total?`, `message` | Source list progress: "Embedding 1,204 chunks · 38%" |
| `memory.proposal` | `proposal_id`, `target_path`, `auto_applied` | Toast with Undo, or the inbox count |
| `node.operation` | `operation_id`, `node_id`, `action`, `status`, `detail` | The confirmation chain |
| `health.changed` | `service`, `status`, `detail?` | Status bar health dot, Health page |
| `mcp.server_changed` | `server_id`, `name`, `status` (connecting, connected, error, disabled, removed), `tools`, `detail?` | Admin → Plugins server list; also sent when a server's tools change |
| `suggestion` | `kind` (branch, compact, model, duplicate_source, stale_source), `ref`, `message` | A quiet chip in context |
| `repo.changed` | `repo_id`, `branch`, `previous_branch?`, `ahead`, `behind`, `changed` | Status bar branch, Repo panel; a branch switch also sends a notification |
| `claude_code.changed` | `what` (install, auth, sessions, thread, limits, mcp), `thread_id?`, `detail?`, `progress?` | Settings → Claude Code, the session list and Settings → Usage. `limits`: Claude Code's plan limits moved (`GET /claude-code/plan-limits`). `mcp`: the list of Claude Code's own MCP servers moved (`GET /claude-code/mcp-servers`). `sessions` with `detail` `importing:<done>/<total>` and `progress` `{ done, total, project, paused }` while Auto-import runs (`paused` while you type), then `imported:<n>` with `progress: null` once at the end of every pass; no detail means the list changed. `thread` names a thread that was brought in or synced. `install` carries the install state, `sdk` or `verification` in `detail` |
| `activity.changed` | `running` | The status bar's count and the Activity panel (docs/activity.md): sent when the number of things running moves |

## Client example

```ts
import { RunEvent } from '@nvx/contracts';

const es = new EventSource(`/api/v1/runs/${runId}/stream`, { withCredentials: true });
es.onmessage = (e) => {
  const ev = RunEvent.parse(JSON.parse(e.data));
  if (ev.type === 'text.delta') append(ev.delta);
  if (ev.type === 'done') es.close();
};
// EventSource sends Last-Event-ID on reconnect by itself.
```

## Track G additions

- `approval.batched` (run event) may carry `out_of_plan: true` and `plan_id`: an approved Auto plan is in force and this call fits none of its steps. The Cockpit shows "1 step outside your plan" with Allow once, Add to plan and Deny.
- `mcp.tools_changed` (global): an MCP server's tool list changed since it was approved (`state: "changed"`), or the new list was approved (`state: "approved"`). `key` is `<origin>:<server>`, `origin` is `host` or `claude_code`; `added`, `removed` and `changed` are counts. The diff itself is on `GET /mcp/approvals`. A `notification` (warn, category `health`, "Review the change") goes with each new change.
- `auto.reviewer` (global): Auto mode's reviewer went `offline` (rules only, asking more often) or came back `online`. Once per change, never per call. `reason` is `no_key`, `key_rejected`, `network` or `model_not_pulled`; `outage_id` is new for each outage; `local_only` says only local reviewers were allowed.
