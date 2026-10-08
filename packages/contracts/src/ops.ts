/**
 * Operations (ROADMAP Phase 5): health, logs, traces and replay, the
 * self-diagnostic, automations, apps connected over MCP, and the licence.
 * Core serves these under /api/v1; the Cockpit's admin screens read them.
 */
import { z } from 'zod';

/* ---- Health ------------------------------------------------------------------ */

export const ServiceHealthView = z.object({
  service: z.string(),
  status: z.enum(['ok', 'degraded', 'down', 'restarting']),
  consecutive_failures: z.number().int(),
  last_ok_at: z.string().nullable(),
  last_error: z.string().nullable(),
  needs_attention: z.boolean(),
  /** What to do, shown with "needs attention". */
  remediation: z.string().nullable().default(null),
  /** Restarts inside the storm window, newest last. */
  restarts: z.array(z.string()).default([]),
  latency_ms: z.number().nullable().default(null),
  /** Whether this service can be restarted from here. */
  restartable: z.boolean().default(false),
});
export type ServiceHealthView = z.infer<typeof ServiceHealthView>;

export const SystemHealth = z.object({
  services: z.array(ServiceHealthView),
  /** none | process | docker: how failed services are brought back. */
  restart_adapter: z.enum(['none', 'process', 'docker']).default('none'),
  interval_s: z.number().int().default(15),
  restart_after: z.number().int().default(3),
});
export type SystemHealth = z.infer<typeof SystemHealth>;

/* ---- Logs -------------------------------------------------------------------- */

export const LogLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
export type LogLevel = z.infer<typeof LogLevel>;

export const LogLine = z.object({
  id: z.number().int(),
  at: z.string(),
  level: LogLevel,
  service: z.string(),
  component: z.string().nullable(),
  trace_id: z.string().nullable(),
  span_id: z.string().nullable(),
  msg: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type LogLine = z.infer<typeof LogLine>;

export const LogQuery = z.object({
  /** Minimum level. */
  level: LogLevel.optional(),
  service: z.string().optional(),
  component: z.string().optional(),
  trace: z.string().optional(),
  q: z.string().max(200).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  /** Older than this id (paging back). */
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export type LogQuery = z.infer<typeof LogQuery>;

export const LogPage = z.object({
  items: z.array(LogLine),
  next_cursor: z.string().nullable(),
  facets: z.object({ services: z.array(z.string()), components: z.array(z.string()) }),
});
export type LogPage = z.infer<typeof LogPage>;

/* ---- Traces and replay ----------------------------------------------------- */

export const SpanView = z.object({
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string().nullable(),
  service: z.string(),
  name: z.string(),
  kind: z.string(),
  start_at: z.string(),
  end_at: z.string().nullable(),
  duration_ms: z.number().nullable(),
  status: z.enum(['ok', 'error', 'unset']),
  attrs: z.record(z.string(), z.unknown()),
  events: z.array(z.unknown()),
});
export type SpanView = z.infer<typeof SpanView>;

export const TraceSummary = z.object({
  trace_id: z.string(),
  name: z.string(),
  service: z.string(),
  start_at: z.string(),
  duration_ms: z.number().nullable(),
  status: z.enum(['ok', 'error', 'unset']),
  spans: z.number().int(),
  run_id: z.string().nullable(),
});
export type TraceSummary = z.infer<typeof TraceSummary>;

export const TraceDetail = z.object({
  trace_id: z.string(),
  spans: z.array(SpanView),
  logs: z.array(LogLine),
  runs: z.array(z.object({ id: z.string(), kind: z.string(), status: z.string() })),
});
export type TraceDetail = z.infer<typeof TraceDetail>;

/** One step of a run, as the replay view steps through it. */
export const ReplayStep = z.object({
  n: z.number().int(),
  kind: z.enum([
    'text',
    'reasoning',
    'tool',
    'model',
    'fallback',
    'retrieval',
    'memory',
    'approval',
    'status',
    'other',
  ]),
  title: z.string(),
  detail: z.string().nullable(),
  at: z.string().nullable(),
  /** Run-event seqs that make up this step. */
  seqs: z.array(z.number().int()),
  /** For tool steps: the call and its recorded result. */
  tool: z
    .object({ name: z.string(), args: z.unknown(), ok: z.boolean().nullable(), result: z.unknown() })
    .nullable()
    .default(null),
  /** True when a re-run can start here. */
  rerunnable: z.boolean(),
});
export type ReplayStep = z.infer<typeof ReplayStep>;

export const RunReplay = z.object({
  run_id: z.string(),
  kind: z.string(),
  status: z.string(),
  trace_id: z.string(),
  thread_id: z.string().nullable(),
  message_id: z.string().nullable(),
  model_id: z.string().nullable(),
  steps: z.array(ReplayStep),
  events: z.array(
    z.object({ seq: z.number().int(), type: z.string(), at: z.string().nullable(), data: z.unknown() }),
  ),
});
export type RunReplay = z.infer<typeof RunReplay>;

export const RerunRequest = z
  .object({
    /** Steps before this one are kept as they were; the new model continues from here. */
    from_step: z.number().int().min(0),
    model: z.string().optional(),
  })
  .strict();
export type RerunRequest = z.infer<typeof RerunRequest>;

/* ---- Self-diagnostic ------------------------------------------------------- */

export const DiagnosticCheck = z.object({
  id: z.string(),
  group: z.enum(['data', 'services', 'models', 'memory', 'security', 'system']),
  title: z.string(),
  status: z.enum(['pending', 'running', 'passed', 'warned', 'failed', 'skipped']),
  detail: z.string().nullable(),
  fix: z.string().nullable(),
  ms: z.number().nullable(),
});
export type DiagnosticCheck = z.infer<typeof DiagnosticCheck>;

export const DiagnosticRun = z.object({
  id: z.string(),
  status: z.enum(['running', 'passed', 'failed']),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  checks: z.array(DiagnosticCheck),
});
export type DiagnosticRun = z.infer<typeof DiagnosticRun>;

/* ---- Automations ----------------------------------------------------------- */

export const AutomationView = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  /** Cron jobs run on a schedule; the others run on events (after a turn, on ingest). */
  trigger: z.enum(['schedule', 'event']),
  cron: z.string().nullable(),
  schedule_words: z.string().nullable(),
  enabled: z.boolean(),
  last_run_at: z.string().nullable(),
  last_status: z.enum(['succeeded', 'failed', 'skipped', 'running']).nullable(),
  last_error: z.string().nullable(),
  last_duration_ms: z.number().nullable(),
  next_run_at: z.string().nullable(),
  runs: z.number().int(),
});
export type AutomationView = z.infer<typeof AutomationView>;

/* ---- Apps connected over MCP ----------------------------------------------- */

export const McpClientView = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  /** The tools this app holds a grant for. */
  tools: z.array(z.string()),
});
export type McpClientView = z.infer<typeof McpClientView>;

export const CreateMcpClientRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    tools: z.array(z.string()).min(1),
  })
  .strict();
export type CreateMcpClientRequest = z.infer<typeof CreateMcpClientRequest>;

/* ---- Licence ---------------------------------------------------------------- */

export const ActivateLicenseRequest = z
  .object({
    /** A claim key (NVX-XXXX-XXXX-XXXX), or a signed token pasted from nvx.sh. */
    key: z.string().trim().min(1).max(4000),
    /** Move the licence here from the computer that holds its seat. */
    transfer: z.boolean().optional(),
  })
  .strict();
export type ActivateLicenseRequest = z.infer<typeof ActivateLicenseRequest>;
