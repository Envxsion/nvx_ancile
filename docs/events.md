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
| `approval.resolved` | `approval_id`, `decision` | Dialog closes; the run resumes |
| `fallback` | `from_model`, `to_model`, `reason`, `detail` | Muted footer note: "answered by X · Y was unavailable" |
| `compute.waiting` | `node_id`, `eta_s`, `can_use_cloud` | "Waking your GPU node · about 80 s", with **Use a cloud model instead** |
| `usage` | `message_id`, `usage` | Footer tokens and cost |
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
| `suggestion` | `kind` (branch, compact, model, duplicate_source, stale_source), `ref`, `message` | A quiet chip in context |
| `repo.changed` | `repo_id`, `branch`, `previous_branch?`, `ahead`, `behind`, `changed` | Status bar branch, Repo panel; a branch switch also sends a notification |

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
