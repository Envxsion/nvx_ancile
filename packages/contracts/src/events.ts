/**
 * Server-sent events. Two streams:
 *   RunEvent    on /api/v1/runs/:id/stream  (persisted, replayable by seq)
 *   GlobalEvent on /api/v1/events            (one per tab, multiplexed)
 * Every event carries a monotonic seq so a reconnect with Last-Event-ID
 * resumes exactly where it left off (DESIGN.md §4.1).
 */
import { z } from 'zod';
import { ImportProgress } from './claudecode';
import { Attempt, ErrorClass } from './errors';
import { LearnedHint } from './flows';
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
    /** What was searched for (EV2); empty on events from before it was recorded. */
    query: z.string().default(''),
    /** Where the search looked: the notebook, only the sources @-mentioned, or context links too. */
    searched: z.enum(['notebook', 'mentioned', 'links']).default('notebook'),
    /** The passages found, best first: the source's title and how closely it matched. */
    found: z
      .array(
        z.object({
          source_title: z.string(),
          page: z.number().int().nullable().default(null),
          score: z.number(),
        }),
      )
      .max(24)
      .default([]),
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
    /** What the step is doing, in words (steps.ts stepTitle): its own description or one made from its input. */
    title: z.string().optional(),
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
    /** cancelled: withdrawn because its turn ended or the model changed (it never ran). */
    decision: z.enum(['approved', 'denied', 'expired', 'cancelled']),
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
  /**
   * What the run is doing between steps that have no part of their own
   * (an engine running its hooks, compacting its context), for the live
   * footer. `phase: null` says that activity ended.
   */
  z.object({
    ...base,
    type: z.literal('activity'),
    phase: z.enum(['hooks', 'compacting']).nullable(),
    /** Words for the footer, such as "Running PostToolUse hooks". */
    detail: z.string().optional(),
  }),
  /**
   * Engines (docs/engines.md): this turn sends some of the thread to an
   * engine outside NVX Ancile (Claude Code). One line the thread shows
   * once, above the answer: `notice` is the words to show.
   */
  z.object({
    ...base,
    type: z.literal('context.shared'),
    message_id: z.string(),
    engine: z.string(),
    notice: z.string(),
    /** Turns by other engines given to it as a digest. */
    turns: z.number().int().nonnegative(),
    /** About how many tokens of the thread went with the turn. */
    tokens: z.number().int().nonnegative(),
    /** The session was started afresh from NVX Ancile's compaction summary. */
    seeded_from_summary: z.boolean(),
    /** Notes on the notebook's sources sent with the turn (sources added or removed). */
    source_notes: z.number().int().nonnegative().optional(),
  }),
  z.object({ ...base, type: z.literal('warning'), code: z.string(), message: z.string() }),
  z.object({
    ...base,
    type: z.literal('error'),
    code: z.string(),
    title: z.string(),
    hint: z.string(),
    attempts: z.array(Attempt),
    /** claude_code.plan_limit: when the plan's limit resets (ISO), so the Cockpit says it in local time. */
    resets_at: z.string().nullable().optional(),
    /** model.pinned_unavailable: dearer models the person can choose instead, each one click. */
    options: z
      .array(z.object({ model_id: z.string(), name: z.string(), price: z.string().optional() }))
      .optional(),
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
    /** Which model stood in when the step's own could not answer, and why. */
    note: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('flow.decision'),
    message_id: z.string(),
    node_id: z.string(),
    chose: z.array(z.string()),
    reason: z.string(),
    confidence: z.number().nullable(),
    /** A router that learns from your choices took part (FL1). */
    learned: LearnedHint.optional(),
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
  /**
   * One claim of a fact-check as it is found (`found`) and as its verdict lands
   * (`judged`), so the Evidence tab fills in live instead of waiting (EV1).
   */
  z.object({
    ...base,
    type: z.literal('factcheck.claim'),
    factcheck_id: z.string(),
    message_id: z.string(),
    state: z.enum(['found', 'judged']),
    /** The claim's place among the claims of this check. */
    index: z.number().int(),
    total: z.number().int(),
    text: z.string(),
    checkable: z.boolean(),
    /** For `judged`: the verdict, the judge's reason and the quotes it relied on. */
    verdict: z.enum(['verified', 'unverified', 'contradicted', 'not_checkable']).optional(),
    rationale: z.string().optional(),
    judge: z.string().nullable().optional(),
    quotes: z
      .array(
        z.object({
          source_title: z.string(),
          quote: z.string(),
          stance: z.enum(['supports', 'contradicts', 'neutral']),
          origin: z.enum(['source', 'web']).default('source'),
        }),
      )
      .max(6)
      .optional(),
  }),
  /** Auto mode (docs/auto-mode.md): a call ran without asking. The quiet "ran automatically" marker. */
  z.object({
    ...base,
    type: z.literal('auto.ran'),
    call_id: z.string().optional(),
    action: z.string(),
    via: z.enum(['plan', 'cache', 'reviewer', 'rules']),
    reviewer: z
      .enum(['jev_openrouter', 'jev_direct', 'decisions', 'decisions_local', 'local_model', 'rules', 'fake'])
      .nullable(),
  }),
  /**
   * Auto mode could not settle a call by itself: its approval joins a group,
   * answered together (POST /approvals/batch). `approval.required` follows.
   */
  z.object({
    ...base,
    type: z.literal('approval.batched'),
    batch_id: z.string(),
    call_id: z.string().optional(),
    action: z.string(),
    via: z.enum(['floor', 'reviewer', 'rules']),
    /** Why it asks, in a sentence. */
    reason: z.string(),
    /**
     * An approved plan is in force and this call fits none of its steps:
     * the Cockpit offers "Add to plan" beside Allow once and Deny.
     */
    out_of_plan: z.boolean().optional(),
    /** The plan it is outside of, when out_of_plan. */
    plan_id: z.string().optional(),
  }),
  /** Auto mode's plan for this thread or run changed (proposed, approved, rejected). */
  z.object({
    ...base,
    type: z.literal('plan.changed'),
    plan_id: z.string(),
    status: z.enum(['proposed', 'approved', 'rejected', 'superseded']),
  }),
  /**
   * A call ran that fits a step of the approved plan (by itself, by your
   * scope or a grant): `step` is the step's index, for "1 of 3 steps".
   */
  z.object({
    ...base,
    type: z.literal('plan.step_ran'),
    plan_id: z.string(),
    step: z.number().int().min(0),
    action: z.string(),
    call_id: z.string().optional(),
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
    /** M2: the person asked for this themselves ("remember that..."): saved at once, with Undo. */
    explicit: z.boolean().optional(),
    /** M8: seen once, kept as a watch item rather than proposed. */
    watching: z.boolean().optional(),
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
    type: z.literal('mcp.server_changed'),
    server_id: z.string(),
    name: z.string(),
    /** connecting | connected | error | disabled | removed */
    status: z.enum(['connecting', 'connected', 'error', 'disabled', 'removed']),
    tools: z.number().int(),
    detail: z.string().optional(),
  }),
  /**
   * An MCP server's tool list changed since it was approved (a rug pull), or
   * the new list was approved. Counts only: the diff is on GET /mcp/approvals.
   */
  z.object({
    ...base,
    type: z.literal('mcp.tools_changed'),
    key: z.string(),
    origin: z.enum(['host', 'claude_code']),
    server: z.string(),
    state: z.enum(['approved', 'changed']),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
  }),
  /** Auto mode's reviewer went offline (rules only, asking more often) or came back. Once per change. */
  z.object({
    ...base,
    type: z.literal('auto.reviewer'),
    status: z.enum(['online', 'offline']),
    outage_id: z.string().nullable(),
    reason: z.enum(['no_key', 'key_rejected', 'network', 'model_not_pulled']).nullable(),
    local_only: z.boolean(),
  }),
  z.object({
    ...base,
    type: z.literal('claude_code.changed'),
    /** What moved: install progress, sign-in, the session list, a thread synced, the plan limits, or its MCP servers. */
    what: z.enum(['install', 'auth', 'sessions', 'thread', 'limits', 'mcp']),
    thread_id: z.string().optional(),
    detail: z.string().optional(),
    /** A background import's progress (with `detail` "importing:<done>/<total>"); null once it ends. */
    progress: ImportProgress.nullable().optional(),
  }),
  /** The model list moved (MD4, MD5): a daily check found something, or a line's latest model changed. */
  z.object({
    ...base,
    type: z.literal('models.changed'),
    what: z.enum(['watch', 'line']),
    /** How many unseen changes there are now. */
    unseen: z.number().int().nonnegative(),
  }),
  /** What is running moved (docs/activity.md): `running` rows now; GET /activity has them. */
  z.object({
    ...base,
    type: z.literal('activity.changed'),
    running: z.number().int().nonnegative(),
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
  z.object({
    ...base,
    /** python_run needs a window to run it (docs/interpreter.md): one claims it, the rest ignore it. */
    type: z.literal('interpreter.requested'),
    request_id: z.string(),
    thread_id: z.string().nullable(),
    call_id: z.string().nullable(),
  }),
]);
export type GlobalEvent = z.infer<typeof GlobalEvent>;
