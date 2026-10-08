/**
 * Server-sent events. Two streams:
 *   RunEvent    on /api/v1/runs/:id/stream  (persisted, replayable by seq)
 *   GlobalEvent on /api/v1/events            (one per tab, multiplexed)
 * Every event carries a monotonic seq so a reconnect with Last-Event-ID
 * resumes exactly where it left off (DESIGN.md §4.1).
 */
import { z } from 'zod';
import { Attempt, ErrorClass } from './errors';
import { Part, Usage } from './messages';

const base = { seq: z.number().int().nonnegative(), at: z.string() };

export const RunStatus = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'waiting_compute',
  'succeeded',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const StepKind = z.enum([
  'context',
  'memory_inject',
  'retrieval',
  'model_call',
  'tool_call',
  'approval_wait',
  'compute_wait',
  'fallback',
  'compaction',
  'citations',
  'post',
]);

export const Tier = z.enum(['auto', 'gated', 'critical']);
export type Tier = z.infer<typeof Tier>;

export const RunEvent = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('run.status'), status: RunStatus, detail: z.string().optional() }),
  z.object({
    ...base,
    type: z.literal('step.started'),
    step: z.number().int(),
    kind: StepKind,
    label: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('step.finished'),
    step: z.number().int(),
    ok: z.boolean(),
    ms: z.number(),
    summary: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('memory.injected'),
    files: z.array(
      z.object({ path: z.string(), commit: z.string(), entries: z.number().int(), tokens: z.number().int() }),
    ),
    truncated: z.number().int().default(0),
  }),
  z.object({
    ...base,
    type: z.literal('retrieval.done'),
    chunks: z.number().int(),
    sources: z.number().int(),
    ms: z.number(),
  }),
  /**
   * The message's parts so far, replacing whatever the client has drawn.
   * Sent when a run resumes after a restart or an approval, so text that
   * was streamed by an attempt that never committed is not shown twice.
   */
  z.object({ ...base, type: z.literal('message.snapshot'), message_id: z.string(), parts: z.array(Part) }),
  z.object({ ...base, type: z.literal('text.delta'), message_id: z.string(), delta: z.string() }),
  z.object({ ...base, type: z.literal('reasoning.delta'), message_id: z.string(), delta: z.string() }),
  z.object({ ...base, type: z.literal('citation'), message_id: z.string(), part: Part }),
  z.object({
    ...base,
    type: z.literal('model'),
    message_id: z.string(),
    model_id: z.string(),
    display_name: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('tool.call'),
    call_id: z.string(),
    tool: z.string(),
    args_preview: z.unknown(),
    tier: Tier,
    /** Flows: the node that made the call. */
    node_id: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('tool.result'),
    call_id: z.string(),
    ok: z.boolean(),
    preview: z.string(),
    /** Flows: the node that made the call. */
    node_id: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('approval.required'),
    approval_id: z.string(),
    tool: z.string(),
    action: z.string(),
    resource: z.string(),
    tier: Tier,
    call_id: z.string().optional(),
    args_preview: z.unknown().optional(),
    /** Pattern suggestions, narrowest first (DESIGN.md §5.4). Empty for critical. */
    suggestions: z.array(z.string()),
  }),
  z.object({
    ...base,
    type: z.literal('approval.resolved'),
    approval_id: z.string(),
    decision: z.enum(['approved', 'denied', 'expired']),
  }),
  z.object({
    ...base,
    type: z.literal('fallback'),
    from_model: z.string(),
    to_model: z.string(),
    reason: ErrorClass,
    detail: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('compute.waiting'),
    node_id: z.string(),
    eta_s: z.number().nullable(),
    can_use_cloud: z.boolean(),
    /** Phase 5: which model is waiting, and the Controller's own words. */
    model_id: z.string().optional(),
    detail: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal('usage'), message_id: z.string(), usage: Usage }),
  z.object({ ...base, type: z.literal('warning'), code: z.string(), message: z.string() }),
  z.object({
    ...base,
    type: z.literal('error'),
    code: z.string(),
    title: z.string(),
    hint: z.string(),
    attempts: z.array(Attempt),
  }),
  z.object({ ...base, type: z.literal('done'), message_id: z.string().nullable() }),
  /** Flows (DESIGN.md §16.5): the teamwork, live. */
  z.object({
    ...base,
    type: z.literal('flow.started'),
    message_id: z.string(),
    flow_id: z.string(),
    name: z.string(),
    version: z.number().int(),
  }),
  z.object({
    ...base,
    type: z.literal('flow.node.started'),
    message_id: z.string(),
    node_id: z.string(),
    kind: z.string(),
    label: z.string().nullable(),
    model_id: z.string().nullable(),
    /** Who handed it the work (the node before it on the path). */
    from: z.array(z.string()),
  }),
  z.object({
    ...base,
    type: z.literal('flow.node.delta'),
    message_id: z.string(),
    node_id: z.string(),
    channel: z.enum(['text', 'reasoning']),
    delta: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('flow.node.finished'),
    message_id: z.string(),
    node_id: z.string(),
    status: z.enum(['done', 'skipped', 'failed', 'pinned', 'cached']),
    ms: z.number(),
    tokens_in: z.number().int(),
    tokens_out: z.number().int(),
    cost_usd: z.number(),
    error: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('flow.decision'),
    message_id: z.string(),
    node_id: z.string(),
    chose: z.array(z.string()),
    reason: z.string(),
    confidence: z.number().nullable(),
  }),
  /** A fact-check run's progress (DESIGN.md §10): stage, and claims done of total. */
  z.object({
    ...base,
    type: z.literal('factcheck.progress'),
    factcheck_id: z.string(),
    message_id: z.string(),
    stage: z.enum(['extracting', 'gathering', 'verifying', 'done', 'failed']),
    done: z.number().int(),
    total: z.number().int(),
  }),
]);
export type RunEvent = z.infer<typeof RunEvent>;

export const OperationStatus = z.enum([
  'requested',
  'acknowledged',
  'in_progress',
  'confirmed',
  'failed',
  'timed_out',
]);
export type OperationStatus = z.infer<typeof OperationStatus>;

export const SuggestionKind = z.enum(['branch', 'compact', 'model', 'duplicate_source', 'stale_source']);

export const GlobalEvent = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('notification'),
    id: z.string(),
    level: z.enum(['info', 'success', 'warn', 'error']),
    title: z.string(),
    body: z.string().optional(),
    action: z.object({ label: z.string(), href: z.string() }).optional(),
    /** Which notification setting governs it (Settings → Notifications). Absent: always a toast. */
    category: z.enum(['approvals', 'runs', 'sources', 'health', 'memory']).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('run.updated'),
    run_id: z.string(),
    status: RunStatus,
    thread_id: z.string().nullable(),
  }),
  z.object({
    ...base,
    type: z.literal('approval.requested'),
    approval_id: z.string(),
    run_id: z.string(),
    tool: z.string(),
    tier: Tier,
  }),
  z.object({ ...base, type: z.literal('approval.resolved'), approval_id: z.string() }),
  z.object({
    ...base,
    type: z.literal('source.progress'),
    source_id: z.string(),
    status: z.string(),
    stage: z.string(),
    done: z.number().int().optional(),
    total: z.number().int().optional(),
    message: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('memory.proposal'),
    proposal_id: z.string(),
    target_path: z.string(),
    auto_applied: z.boolean(),
    /** The entry as written, for the toast (Phase 4). */
    text: z.string().optional(),
    kind: z.string().optional(),
    /** The answer and run it was learned from, when there is one (flows' memory tray). */
    message_id: z.string().optional(),
    run_id: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('node.operation'),
    operation_id: z.string(),
    node_id: z.string(),
    action: z.string(),
    status: OperationStatus,
    detail: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('health.changed'),
    service: z.string(),
    status: z.enum(['ok', 'degraded', 'down', 'restarting']),
    detail: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('repo.changed'),
    repo_id: z.string(),
    branch: z.string().nullable(),
    /** The branch before, when the branch changed. */
    previous_branch: z.string().nullable().optional(),
    ahead: z.number().int(),
    behind: z.number().int(),
    changed: z.number().int(),
  }),
  z.object({
    ...base,
    type: z.literal('suggestion'),
    kind: SuggestionKind,
    ref: z.string(),
    message: z.string(),
    /** The thread it is about, when it is about one (branch, compact). */
    thread_id: z.string().optional(),
    /** A short name for what it suggests, e.g. the new topic for a branch. */
    title: z.string().optional(),
  }),
]);
export type GlobalEvent = z.infer<typeof GlobalEvent>;
