/**
 * Anonymous usage statistics (docs/telemetry.md). Off until you say yes.
 * Same shape as the rest of the NVX family: an install id minted only on
 * consent and never linked to a licence or an email, a closed set of
 * events, flat data, every count and time in a bucket, never text you
 * wrote, names, paths, URLs or model output. The server rejects any key
 * that is not listed here, so this file is the whole of what can be sent.
 */
import { z } from 'zod';

export const TELEMETRY_SCHEMA = 1;

/** Counts: small numbers are kept as they are, larger ones in ranges. */
export const COUNT_BUCKETS = ['0', '1', '2-3', '4-6', '7-12', '13+'] as const;
/** Counts that run larger (sources, threads). */
export const WIDE_BUCKETS = ['0', '1-9', '10-49', '50-99', '100-499', '500+'] as const;
/** Durations. */
export const MS_BUCKETS = [
  '<250',
  '250-499',
  '500-999',
  '1-2s',
  '2-4s',
  '4-8s',
  '8-16s',
  '16-32s',
  '32s+',
] as const;

const Count = z.enum(COUNT_BUCKETS);
const Wide = z.enum(WIDE_BUCKETS);
const Ms = z.enum(MS_BUCKETS);
/** Days since the rolled-up day: 1 is yesterday. */
const Lag = z.enum(['1', '2', '3-7', '8+']);

export const TELEMETRY_EVENTS = [
  'install',
  'update',
  'startup',
  'active',
  'daily_counts',
  'perf',
  'first_use',
  'funnel',
  'flow_shape',
  'error',
  'exception',
] as const;
export const TelemetryEventName = z.enum(TELEMETRY_EVENTS);
export type TelemetryEventName = z.infer<typeof TelemetryEventName>;

/** Every feature the app can report using, by its own name. */
export const FEATURES = [
  'send',
  'regenerate_same',
  'regenerate_again',
  'regenerate_model',
  'edit_question',
  'branch',
  'branch_rename',
  'merge',
  'compare',
  'compact',
  'tree_full',
  'factcheck',
  'why',
  'evidence',
  'citation_open',
  'memory_accept',
  'memory_reject',
  'memory_edit',
  'memory_restore',
  'lab_run',
  'lab_undo',
  'flow_create',
  'flow_try',
  'flow_publish',
  'flow_activate',
  'flow_turn',
  'flow_route_again',
  'flow_yaml',
  'source_file',
  'source_url',
  'source_text',
  'note_save',
  'notebook_create',
  'model_add',
  'model_switch',
  'mention_source',
  'mention_model',
  'mention_flow',
  'approval_allow',
  'approval_deny',
  'compute_start',
  'compute_stop',
  'compute_cloud_instead',
  'mcp_add',
  'automation_add',
  'diagnostics_run',
  'logs_open',
  'traces_open',
  'replay',
  'palette',
  'settings_change',
  'settings_import',
  'tour_start',
  'tour_finish',
  'checklist_step',
  'glossary_open',
  'help_open',
  'key_test',
  'focus_mode',
  'theme_toggle',
  'export',
] as const;
export const Feature = z.enum(FEATURES);
export type Feature = z.infer<typeof Feature>;

/** Where in the app a control lives, for shortcut-or-click counts. */
export const UI_AREAS = [
  'shell',
  'thread',
  'composer',
  'tree',
  'flow',
  'palette',
  'settings',
  'admin',
  'help',
] as const;
export const UiArea = z.enum(UI_AREAS);

/** First-run steps, each reported once per install. */
export const FUNNEL_STEPS = [
  'setup_opened',
  'model_ready',
  'permissions_chosen',
  'notebook_created',
  'source_added',
  'first_question',
  'first_grounded_answer',
  'first_branch',
  'first_flow_try',
  'first_flow_active',
  'checklist_done',
] as const;
export const FunnelStep = z.enum(FUNNEL_STEPS);

export const PROVIDER_KINDS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'endpoint',
  'node',
  'ollama',
  'offline',
] as const;

export const FLOW_NODE_KINDS = [
  'input',
  'output',
  'model',
  'router',
  'rule',
  'manager',
  'parallel',
  'join',
  'context',
  'tool',
  'template',
  'human',
  'subflow',
  'retrieve',
  'factcheck',
  'loop',
  'note',
  'group',
] as const;

/* ---- Data per event ---------------------------------------------------------- */

const Env = {
  os: z.enum(['windows', 'macos', 'linux', 'other']),
  arch: z.enum(['x64', 'arm64', 'other']),
  runtime: z.enum(['browser', 'desktop']),
  browser: z.enum(['chrome', 'edge', 'firefox', 'safari', 'opera', 'brave', 'arc', 'vivaldi', 'other']),
  browser_major: z.number().int().min(0).max(999),
  /** Primary language subtag only ("en", never "en-AU"). */
  lang: z.string().regex(/^[a-z]{2,3}$/),
  /** Whole-hour UTC offset, never a named zone. */
  tz: z.number().int().min(-12).max(14),
  ram: z.enum(['lt8', '8-15', '16-31', '32-63', '64+']),
  cores: z.enum(['1-2', '3-4', '5-8', '9-16', '17+']),
  theme: z.enum(['light', 'dark', 'system']),
  /** The window is a phone-sized layout. */
  narrow: z.boolean(),
};

const Usage = {
  tier: z.enum(['free', 'pro', 'max_access']),
  notebooks: Count,
  threads: Wide,
  sources: Wide,
  sources_file: Wide,
  sources_url: Wide,
  sources_text: Wide,
  memory_files: Count,
  flows: Count,
  flows_active: Count,
  gpu_nodes: Count,
  mcp_servers: Count,
  automations: Count,
  /** Ready models by where they come from. */
  ...Object.fromEntries(PROVIDER_KINDS.map((k) => [`models_${k}`, Count])),
  /** Days with at least one message, in the last 7 and 28. */
  days_7: z.enum(['0', '1', '2', '3', '4', '5', '6', '7']),
  days_28: z.enum(['0', '1-3', '4-7', '8-14', '15-21', '22-28']),
  /** Weeks since the first run. */
  since_install: z.enum(['0', '1', '2-3', '4-8', '9-26', '27+']),
  permission_preset: z.enum(['careful', 'balanced', 'hands_off', 'custom']),
  memory_mode: z.enum(['ask', 'confident', 'auto', 'off', 'unknown']),
  single_keys: z.boolean(),
};

/** daily_counts: per-day counters, each in COUNT_BUCKETS or WIDE_BUCKETS. Only non-zero ones are sent. */
export const DAILY_COUNTERS = [
  'messages',
  'answers',
  'answers_failed',
  'answers_stopped',
  'grounded_answers',
  'fallbacks',
  'refusal_retries',
  'tool_calls',
  'approvals_asked',
  'compute_waits',
  'flow_turns',
  'flow_nodes',
  'flow_guard_stops',
  ...FEATURES.map((f) => `f_${f}` as const),
  ...UI_AREAS.map((a) => `shortcut_${a}` as const),
  ...UI_AREAS.map((a) => `click_${a}` as const),
] as const;

const DailyCounts = {
  lag: Lag,
  ...Object.fromEntries(DAILY_COUNTERS.map((k) => [k, z.union([Count, Wide])])),
};

/** perf: the rolled-up day's p50 and p95 of each timing, as MS_BUCKETS. */
export const PERF_METRICS = [
  'first_token',
  'answer',
  'flow_answer',
  'flow_node',
  'retrieval',
  'ingest_per_mb',
  'factcheck',
  'compute_wake',
  'boot',
  'api',
] as const;

const Perf = {
  lag: Lag,
  ...Object.fromEntries(
    PERF_METRICS.flatMap((m) => [
      [`${m}_p50`, Ms],
      [`${m}_p95`, Ms],
      [`${m}_n`, Count],
    ]),
  ),
};

const FlowShape = {
  nodes: Count,
  depth: Count,
  models: Count,
  scope: z.enum(['workspace', 'notebook', 'thread']),
  /** What made the flow be reported: published or turned on. */
  on: z.enum(['publish', 'activate']),
  ...Object.fromEntries(FLOW_NODE_KINDS.map((k) => [`k_${k}`, z.boolean()])),
  /** Edges that narrow what crosses them (no conversation, plan only, a budget). */
  narrowed_edges: Count,
};

/** Each event's data. Keys outside these are refused, here and on the server. */
export const EVENT_DATA = {
  install: z.object({}).strict(),
  update: z.object({ from: z.string().regex(/^\d+\.\d+$/) }).strict(),
  startup: z.object({}).strict(),
  active: z
    .object({ ...Env, ...Usage })
    .partial()
    .strict(),
  daily_counts: z.object(DailyCounts).partial().required({ lag: true }).strict(),
  perf: z.object(Perf).partial().required({ lag: true }).strict(),
  first_use: z.object({ feature: Feature, via: z.enum(['click', 'shortcut', 'palette', 'api']) }).strict(),
  funnel: z.object({ step: FunnelStep }).strict(),
  flow_shape: z.object(FlowShape).partial().required({ nodes: true, on: true }).strict(),
  /** An AncileError code from docs/errors.md; at most once per code per day. */
  error: z
    .object({
      category: z.string().regex(/^[a-z_]+\.[a-z_.]+$/),
      status: z.enum(['4xx', '5xx', 'stream']),
    })
    .strict(),
  /** A crash: where, and the error's constructor name only, never its message or stack. */
  exception: z
    .object({
      where: z.enum(['core', 'cockpit', 'worker', 'flow', 'knowledge', 'controller']),
      kind: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/),
    })
    .strict(),
} as const satisfies Record<TelemetryEventName, z.ZodTypeAny>;

export const TelemetryEnvelope = z.object({
  /** Random install id (UUID v4), made when you say yes and erased when you say no. */
  id: z.string().uuid(),
  /** NVX Ancile version, "1.4.0". */
  v: z.string().max(32),
  channel: z.enum(['release', 'dev']),
  /** Per-install sequence number, so the server can drop duplicates on (id, seq). */
  seq: z.number().int().min(0),
  event: TelemetryEventName,
  /** Epoch milliseconds. */
  at: z.number().int(),
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type TelemetryEnvelope = z.infer<typeof TelemetryEnvelope>;

export const TelemetryBatch = z.object({
  schema: z.literal(TELEMETRY_SCHEMA),
  product: z.literal('ancile'),
  batch: z.array(TelemetryEnvelope).min(1).max(50),
});
export type TelemetryBatch = z.infer<typeof TelemetryBatch>;

/** An envelope is valid when its data matches its event exactly. */
export function validEnvelope(e: TelemetryEnvelope): boolean {
  return EVENT_DATA[e.event].safeParse(e.data).success;
}

/* ---- Core API (Cockpit ↔ Core) ----------------------------------------------- */

export const TelemetryConsent = z.enum(['unset', 'granted', 'declined']);
export type TelemetryConsent = z.infer<typeof TelemetryConsent>;

export const TelemetryStatus = z.object({
  consent: TelemetryConsent,
  /** An endpoint is configured; without one nothing is ever sent, whatever you chose. */
  endpoint: z.boolean(),
  /** Envelopes waiting to be sent. */
  queued: z.number().int(),
  last_sent_at: z.string().nullable(),
});
export type TelemetryStatus = z.infer<typeof TelemetryStatus>;

export const TelemetryConsentRequest = z.object({ share: z.boolean() }).strict();

/** Counters from the Cockpit, every few minutes. Counts only, no text. */
export const TelemetryUiRequest = z
  .object({
    counters: z.record(z.string().max(48), z.number().int().min(0).max(10_000)).optional(),
    first_use: z
      .array(z.object({ feature: Feature, via: z.enum(['click', 'shortcut', 'palette']) }))
      .max(20)
      .optional(),
    funnel: z.array(FunnelStep).max(11).optional(),
    timings: z
      .array(z.object({ metric: z.enum(PERF_METRICS), ms: z.number().int().min(0).max(3_600_000) }))
      .max(100)
      .optional(),
    exceptions: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/))
      .max(10)
      .optional(),
    env: z
      .object({
        browser: Env.browser,
        browser_major: Env.browser_major,
        lang: Env.lang,
        tz: Env.tz,
        theme: Env.theme,
        narrow: Env.narrow,
        runtime: Env.runtime,
      })
      .partial()
      .optional(),
  })
  .strict();
export type TelemetryUiRequest = z.infer<typeof TelemetryUiRequest>;
