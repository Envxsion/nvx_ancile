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

/** Built-in jobs come from config/automations.yaml; your own are made in Admin → Automations. */
export const AutomationOrigin = z.enum(['builtin', 'user']);
export type AutomationOrigin = z.infer<typeof AutomationOrigin>;

/**
 * What your own automations can do. Each is built on something Core already
 * does: a turn in a new thread, a flow answering a message, the stale-link
 * check, a notification.
 */
export const UserAutomationKind = z.enum(['ask_model', 'run_flow', 'recheck_sources', 'notify']);
export type UserAutomationKind = z.infer<typeof UserAutomationKind>;

const AutomationPrompt = z.string().trim().min(1).max(8_000);

/** Ask a model on a schedule: a new thread each run, with this message sent in it. */
export const AskModelConfig = z
  .object({
    prompt: AutomationPrompt,
    /** Ground the answer in this notebook's sources. */
    notebook_id: z.string().min(1).nullable().default(null),
    /** A chat model's id; null for the default model. */
    model: z.string().min(1).nullable().default(null),
  })
  .strict();
export type AskModelConfig = z.infer<typeof AskModelConfig>;

/** Run a flow on a schedule: like ask_model, answered through this flow. */
export const RunFlowConfig = z
  .object({
    flow_id: z.string().min(1),
    prompt: AutomationPrompt,
    notebook_id: z.string().min(1).nullable().default(null),
  })
  .strict();
export type RunFlowConfig = z.infer<typeof RunFlowConfig>;

/** Re-check one notebook's web sources for changes. */
export const RecheckSourcesConfig = z.object({ notebook_id: z.string().min(1) }).strict();
export type RecheckSourcesConfig = z.infer<typeof RecheckSourcesConfig>;

/** A reminder in the notification centre. */
export const NotifyConfig = z
  .object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().max(1_000).default(''),
  })
  .strict();
export type NotifyConfig = z.infer<typeof NotifyConfig>;

/** The config schema for each kind of automation you can make. */
export const UserAutomationConfig = {
  ask_model: AskModelConfig,
  run_flow: RunFlowConfig,
  recheck_sources: RecheckSourcesConfig,
  notify: NotifyConfig,
} as const satisfies Record<UserAutomationKind, z.ZodTypeAny>;

/** One setting of a built-in job that can be changed from Admin. */
export const AutomationOption = z.object({
  key: z.string(),
  label: z.string(),
  hint: z.string().nullable(),
  type: z.enum(['integer', 'boolean']),
  min: z.number().nullable(),
  max: z.number().nullable(),
  /** Shown after the field: "days", "hours". */
  unit: z.string().nullable(),
  default: z.union([z.number(), z.boolean()]),
});
export type AutomationOption = z.infer<typeof AutomationOption>;

export const AutomationView = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  origin: AutomationOrigin,
  /** The built-in job's id, or what your own automation does (UserAutomationKind). */
  kind: z.string(),
  /** Cron jobs run on a schedule; the others run on events (after a turn, on ingest). */
  trigger: z.enum(['schedule', 'event']),
  cron: z.string().nullable(),
  schedule_words: z.string().nullable(),
  /** Built-in: the schedule in automations.yaml, for Reset to default. Null for your own. */
  default_cron: z.string().nullable(),
  /** Built-in: the schedule or settings were changed here (Reset to default undoes it). */
  customised: z.boolean(),
  config: z.record(z.string(), z.unknown()),
  /** Built-in: the settings that can be changed (empty when there are none). */
  options: z.array(AutomationOption),
  /** Set when the job cannot run until something is configured; it is not run meanwhile. */
  setup: z.object({ title: z.string(), hint: z.string() }).nullable(),
  enabled: z.boolean(),
  last_run_at: z.string().nullable(),
  last_status: z.enum(['succeeded', 'failed', 'skipped', 'running']).nullable(),
  last_error: z.string().nullable(),
  /** What the last run did, in a sentence, and where to see it (a thread, a notebook). */
  last_detail: z.string().nullable(),
  last_href: z.string().nullable(),
  last_duration_ms: z.number().nullable(),
  next_run_at: z.string().nullable(),
  runs: z.number().int(),
});
export type AutomationView = z.infer<typeof AutomationView>;

const AutomationTitle = z.string().trim().min(1).max(80);
const AutomationCron = z.string().trim().min(1).max(120);
const createBase = {
  title: AutomationTitle,
  cron: AutomationCron,
  enabled: z.boolean().default(true),
};

/** POST /automations: one of your own. Core checks the schedule (automation.bad_schedule). */
export const CreateAutomationRequest = z.discriminatedUnion('kind', [
  z.object({ ...createBase, kind: z.literal('ask_model'), config: AskModelConfig }).strict(),
  z.object({ ...createBase, kind: z.literal('run_flow'), config: RunFlowConfig }).strict(),
  z.object({ ...createBase, kind: z.literal('recheck_sources'), config: RecheckSourcesConfig }).strict(),
  z.object({ ...createBase, kind: z.literal('notify'), config: NotifyConfig }).strict(),
]);
export type CreateAutomationRequest = z.input<typeof CreateAutomationRequest>;

/**
 * PATCH /automations/:id. A built-in job takes enabled, cron and config (its
 * options only, merged into what it has). Your own also take a title, and
 * their config is replaced whole and checked against their kind.
 */
export const UpdateAutomationRequest = z
  .object({
    enabled: z.boolean().optional(),
    title: AutomationTitle.optional(),
    cron: AutomationCron.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type UpdateAutomationRequest = z.infer<typeof UpdateAutomationRequest>;

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
