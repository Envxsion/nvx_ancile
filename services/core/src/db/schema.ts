/**
 * ------------------------------------------------------------------
 *  Title    |  Core schema
 *  Ref      |  DESIGN.md §3.1 (keep the two in step)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Every table Core owns, in the `core` Postgres schema.
 *           |  Knowledge and the Controller own their own schemas and
 *           |  Core never writes to them.
 *  Note     |  The hand-written migration in migrations/0000_init.sql is
 *           |  authoritative for things drizzle cannot express (generated
 *           |  columns, partial indexes). Regenerate with drizzle-kit and
 *           |  diff before committing.
 * ------------------------------------------------------------------
 */

import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const core = pgSchema('core');

/** pgvector without a fixed dimension: dimensions vary by embedding model. */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (v) => `[${v.join(',')}]`,
  fromDriver: (v) => JSON.parse(v) as number[],
});

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
const created = () => ts('created_at').notNull().defaultNow();
const updated = () => ts('updated_at').notNull().defaultNow();

/* ---- Identity ------------------------------------------------------------ */

export const users = core.table('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  email: text('email'),
  passphraseHash: text('passphrase_hash'),
  createdAt: created(),
});

export const workspaces = core.table('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  settings: jsonb('settings').notNull().default({}),
  createdAt: created(),
});

export const members = core.table(
  'members',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', { enum: ['owner', 'editor', 'viewer'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

/* ---- Notebooks ----------------------------------------------------------- */

export const notebooks = core.table(
  'notebooks',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    icon: text('icon'),
    color: text('color'),
    memoryPath: text('memory_path').notNull(),
    settings: jsonb('settings').notNull().default({}),
    archivedAt: ts('archived_at'),
    pinnedAt: ts('pinned_at'),
    deletedAt: ts('deleted_at'),
    lastOpenedAt: ts('last_opened_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex('notebooks_ws_slug').on(t.workspaceId, t.slug)],
);

export const notes = core.table('notes', {
  id: text('id').primaryKey(),
  notebookId: text('notebook_id')
    .notNull()
    .references(() => notebooks.id),
  kind: text('kind', { enum: ['human', 'ai'] }).notNull(),
  title: text('title').notNull(),
  contentMd: text('content_md').notNull().default(''),
  fromMessageId: text('from_message_id'),
  fromInsightId: text('from_insight_id'),
  pinnedAt: ts('pinned_at'),
  deletedAt: ts('deleted_at'),
  createdAt: created(),
  updatedAt: updated(),
});

/* ---- Threads and the message tree (§8) ----------------------------------- */

export const threads = core.table(
  'threads',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    notebookId: text('notebook_id').references(() => notebooks.id),
    title: text('title').notNull().default('New thread'),
    titleSource: text('title_source', { enum: ['auto', 'user'] })
      .notNull()
      .default('auto'),
    rootMessageId: text('root_message_id'),
    activeHeadId: text('active_head_id'),
    settings: jsonb('settings').notNull().default({}),
    pinnedTldrId: text('pinned_tldr_id'),
    archivedAt: ts('archived_at'),
    pinnedAt: ts('pinned_at'),
    deletedAt: ts('deleted_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index('threads_ws_updated').on(t.workspaceId, t.updatedAt)],
);

export const messages = core.table(
  'messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id),
    parentId: text('parent_id'),
    role: text('role', { enum: ['system', 'user', 'assistant', 'tool'] }).notNull(),
    parts: jsonb('parts').notNull(),
    modelId: text('model_id'),
    requestedModelId: text('requested_model_id'),
    status: text('status', { enum: ['pending', 'streaming', 'complete', 'stopped', 'error'] }).notNull(),
    editOfId: text('edit_of_id'),
    provenance: jsonb('provenance').notNull().default({}),
    usage: jsonb('usage'),
    runId: text('run_id'),
    traceId: text('trace_id').notNull(),
    createdAt: created(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('messages_thread_parent').on(t.threadId, t.parentId),
    index('messages_parent').on(t.parentId),
  ],
);

export const branches = core.table('branches', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threads.id),
  headMessageId: text('head_message_id').notNull(),
  forkMessageId: text('fork_message_id').notNull(),
  name: text('name').notNull(),
  color: text('color').notNull(),
  createdBy: text('created_by', { enum: ['user', 'suggestion'] })
    .notNull()
    .default('user'),
  archivedAt: ts('archived_at'),
  createdAt: created(),
});

export const summaries = core.table(
  'summaries',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id),
    uptoMessageId: text('upto_message_id').notNull(),
    kind: text('kind', { enum: ['tldr', 'compaction'] }).notNull(),
    content: text('content').notNull(),
    tokens: integer('tokens').notNull(),
    modelId: text('model_id').notNull(),
    createdAt: created(),
  },
  (t) => [index('summaries_upto').on(t.uptoMessageId, t.kind)],
);

export const drafts = core.table(
  'drafts',
  {
    threadId: text('thread_id').notNull(),
    parentId: text('parent_id').notNull(), // '' for a thread's first message
    userId: text('user_id').notNull(),
    content: jsonb('content').notNull(),
    attachments: jsonb('attachments').notNull().default([]),
    updatedAt: updated(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.parentId, t.userId] })],
);

export const uiState = core.table(
  'ui_state',
  {
    userId: text('user_id').notNull(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedAt: updated(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const settings = core.table('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updated(),
});

/* ---- Durable runs (§7.5) ------------------------------------------------- */

export const runs = core.table(
  'runs',
  {
    id: text('id').primaryKey(),
    kind: text('kind', {
      enum: ['chat_turn', 'agent', 'research', 'factcheck', 'automation', 'diagnostic', 'flow_try'],
    }).notNull(),
    threadId: text('thread_id'),
    messageId: text('message_id'),
    status: text('status', {
      enum: ['queued', 'running', 'waiting_approval', 'waiting_compute', 'succeeded', 'failed', 'cancelled'],
    }).notNull(),
    checkpoint: jsonb('checkpoint'),
    stepCursor: integer('step_cursor').notNull().default(0),
    attempt: integer('attempt').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseUntil: ts('lease_until'),
    error: jsonb('error'),
    traceId: text('trace_id').notNull(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index('runs_status_lease').on(t.status, t.leaseUntil),
    // One live run per thread (0002_run_safety.sql).
    uniqueIndex('runs_one_active_per_thread')
      .on(t.threadId)
      .where(sql`status IN ('queued','running','waiting_approval','waiting_compute')`),
  ],
);

export const runSteps = core.table(
  'run_steps',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status', {
      enum: ['in_progress', 'waiting', 'succeeded', 'failed', 'skipped', 'uncertain'],
    }).notNull(),
    input: jsonb('input'),
    output: jsonb('output'),
    error: jsonb('error'),
    spanId: text('span_id'),
    startedAt: ts('started_at').notNull().defaultNow(),
    endedAt: ts('ended_at'),
  },
  (t) => [uniqueIndex('run_steps_run_seq').on(t.runId, t.seq)],
);

export const runEvents = core.table(
  'run_events',
  {
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    data: jsonb('data').notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

/* ---- Permissions (§5) ---------------------------------------------------- */

export const grants = core.table(
  'grants',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    principal: text('principal').notNull(),
    actionPattern: text('action_pattern').notNull(),
    resourcePattern: text('resource_pattern').notNull(),
    effect: text('effect', { enum: ['allow', 'deny'] }).notNull(),
    tier: text('tier', { enum: ['gated'] })
      .notNull()
      .default('gated'),
    scope: text('scope', { enum: ['thread', 'notebook', 'workspace', 'always'] }).notNull(),
    scopeRef: text('scope_ref'),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
    createdFromApprovalId: text('created_from_approval_id'),
    uses: integer('uses').notNull().default(0),
    lastUsedAt: ts('last_used_at'),
    createdAt: created(),
  },
  (t) => [index('grants_active').on(t.userId, t.principal).where(sql`revoked_at IS NULL`)],
);

export const approvals = core.table(
  'approvals',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    stepSeq: integer('step_seq').notNull(),
    principal: text('principal').notNull(),
    threadId: text('thread_id'),
    callId: text('call_id'),
    tool: text('tool').notNull(),
    action: text('action').notNull(),
    resource: text('resource').notNull(),
    args: jsonb('args'),
    argsPreview: jsonb('args_preview'),
    suggestions: jsonb('suggestions').notNull().default([]),
    tier: text('tier', { enum: ['gated', 'critical'] }).notNull(),
    status: text('status', { enum: ['pending', 'approved', 'denied', 'expired', 'cancelled'] }).notNull(),
    decisionScope: text('decision_scope'),
    decisionPattern: text('decision_pattern'),
    decidedBy: text('decided_by'),
    decidedAt: ts('decided_at'),
    reason: text('reason'),
    expiresAt: ts('expires_at'),
    createdAt: created(),
  },
  (t) => [
    index('approvals_pending').on(t.status).where(sql`status = 'pending'`),
    // One approval per tool call, so a retried ask reuses it (0002_run_safety.sql).
    uniqueIndex('approvals_one_per_call').on(t.runId, t.callId),
  ],
);

export const decisions = core.table(
  'decisions',
  {
    id: text('id').primaryKey(),
    at: ts('at').notNull().defaultNow(),
    userId: text('user_id').notNull(),
    principal: text('principal').notNull(),
    action: text('action').notNull(),
    resource: text('resource').notNull(),
    tier: text('tier', { enum: ['auto', 'gated', 'critical'] }).notNull(),
    outcome: text('outcome', {
      enum: ['auto', 'grant', 'approved', 'denied', 'policy_deny', 'expired'],
    }).notNull(),
    grantId: text('grant_id'),
    approvalId: text('approval_id'),
    policyId: text('policy_id'),
    runId: text('run_id'),
    traceId: text('trace_id').notNull(),
  },
  (t) => [index('decisions_at').on(t.at)],
);

/* ---- Memory (§6): derived from the git repo, rebuildable ----------------- */

export const memoryEntries = core.table(
  'memory_entries',
  {
    id: text('id').primaryKey(),
    path: text('path').notNull(),
    scope: text('scope').notNull(),
    notebookId: text('notebook_id'),
    entryKey: text('entry_key').notNull(),
    text: text('text').notNull(),
    meta: jsonb('meta').notNull().default({}),
    embedding: vector('embedding'),
    commitSha: text('commit_sha').notNull(),
    validFrom: ts('valid_from'),
    supersededBy: text('superseded_by'),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex('memory_entries_path_key').on(t.path, t.entryKey)],
);

export const memoryProposals = core.table('memory_proposals', {
  id: text('id').primaryKey(),
  kind: text('kind', {
    enum: ['preference', 'failure_lesson', 'project_finding', 'model_quirk', 'manual'],
  }).notNull(),
  targetPath: text('target_path').notNull(),
  op: text('op', { enum: ['add', 'update', 'supersede'] }).notNull(),
  patch: text('patch').notNull(),
  rationale: text('rationale').notNull(),
  evidence: jsonb('evidence').notNull().default([]),
  confidence: real('confidence').notNull(),
  status: text('status', { enum: ['proposed', 'applied', 'rejected', 'auto_applied'] }).notNull(),
  commitSha: text('commit_sha'),
  createdAt: created(),
  decidedAt: ts('decided_at'),
});

/* ---- Models and routing (§7) --------------------------------------------- */

export const models = core.table('models', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  providerModel: text('provider_model').notNull(),
  displayName: text('display_name').notNull(),
  via: text('via', { enum: ['direct', 'controller'] }).notNull(),
  contextWindow: integer('context_window').notNull(),
  maxOutput: integer('max_output').notNull(),
  capabilities: text('capabilities').array().notNull().default(sql`'{}'`),
  family: text('family').notNull(),
  priceIn: doublePrecision('price_in').notNull().default(0),
  priceOut: doublePrecision('price_out').notNull().default(0),
  priceCached: doublePrecision('price_cached'),
  enabled: boolean('enabled').notNull().default(true),
  config: jsonb('config').notNull().default({}),
});

export const modelStats = core.table(
  'model_stats',
  {
    modelId: text('model_id').notNull(),
    taskClass: text('task_class').notNull(),
    windowStart: ts('window_start').notNull(),
    calls: integer('calls').notNull().default(0),
    successes: integer('successes').notNull().default(0),
    refusals: integer('refusals').notNull().default(0),
    fallbacksFrom: integer('fallbacks_from').notNull().default(0),
    p50Ms: integer('p50_ms'),
    p95Ms: integer('p95_ms'),
    thumbsUp: integer('thumbs_up').notNull().default(0),
    thumbsDown: integer('thumbs_down').notNull().default(0),
    factcheckMean: real('factcheck_mean'),
  },
  (t) => [primaryKey({ columns: [t.modelId, t.taskClass, t.windowStart] })],
);

/* ---- Fact-checking (§10) ------------------------------------------------- */

export const factchecks = core.table('factchecks', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull(),
  status: text('status', { enum: ['running', 'done', 'failed'] }).notNull(),
  confidence: real('confidence'),
  verifierModelId: text('verifier_model_id'),
  runId: text('run_id'),
  createdAt: created(),
});

export const claims = core.table('claims', {
  id: text('id').primaryKey(),
  factcheckId: text('factcheck_id')
    .notNull()
    .references(() => factchecks.id),
  text: text('text').notNull(),
  charStart: integer('char_start').notNull(),
  charEnd: integer('char_end').notNull(),
  importance: real('importance').notNull().default(1),
  verdict: text('verdict', { enum: ['verified', 'unverified', 'contradicted', 'not_checkable'] }).notNull(),
  confidence: real('confidence').notNull(),
  support: real('support').notNull(),
  agreement: real('agreement').notNull(),
  retrieval: real('retrieval').notNull(),
  evidence: jsonb('evidence').notNull().default([]),
  rationale: text('rationale'),
});

/* ---- Tools and integrations ---------------------------------------------- */

export const mcpServers = core.table('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  transport: text('transport', { enum: ['stdio', 'http'] }).notNull(),
  command: text('command'),
  args: jsonb('args').notNull().default([]),
  url: text('url'),
  envSecretIds: text('env_secret_ids').array().notNull().default(sql`'{}'`),
  oauth: jsonb('oauth'),
  enabled: boolean('enabled').notNull().default(true),
  toolOverrides: jsonb('tool_overrides').notNull().default({}),
  health: jsonb('health'),
});

export const secrets = core.table('secrets', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  ciphertext: bytea('ciphertext').notNull(),
  nonce: bytea('nonce').notNull(),
  createdAt: created(),
  rotatedAt: ts('rotated_at'),
});

export const personas = core.table('personas', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  systemPromptPath: text('system_prompt_path').notNull(),
  defaultModelId: text('default_model_id'),
  tools: text('tools').array().notNull().default(sql`'{}'`),
  memoryScope: text('memory_scope').notNull().default('workspace'),
  createdAt: created(),
});

export const automations = core.table('automations', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  cron: text('cron'),
  config: jsonb('config').notNull().default({}),
  enabled: boolean('enabled').notNull().default(true),
  lastRunAt: ts('last_run_at'),
  lastStatus: text('last_status'),
  nextRunAt: ts('next_run_at'),
  // 0007_obs
  lastError: jsonb('last_error'),
  lastDurationMs: integer('last_duration_ms'),
  runs: integer('runs').notNull().default(0),
  // 0011_automations: your own automations, and built-ins changed in Admin
  origin: text('origin', { enum: ['builtin', 'user'] })
    .notNull()
    .default('builtin'),
  title: text('title'),
  customised: boolean('customised').notNull().default(false),
  lastDetail: text('last_detail'),
  lastHref: text('last_href'),
  createdAt: created(),
});

/* ---- Observability (§11) ------------------------------------------------- */
// TODO(phase-5): convert spans and logs to daily range partitions on start_at/at
// so retention drops a partition instead of deleting rows.

export const spans = core.table(
  'spans',
  {
    traceId: text('trace_id').notNull(),
    spanId: text('span_id').notNull(),
    parentSpanId: text('parent_span_id'),
    service: text('service').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    startAt: ts('start_at').notNull(),
    endAt: ts('end_at'),
    status: text('status').notNull(),
    attrs: jsonb('attrs').notNull().default({}),
    events: jsonb('events').notNull().default([]),
  },
  (t) => [primaryKey({ columns: [t.traceId, t.spanId] }), index('spans_start').on(t.startAt)],
);

export const logs = core.table(
  'logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull().defaultNow(),
    level: text('level').notNull(),
    service: text('service').notNull(),
    component: text('component'),
    traceId: text('trace_id'),
    spanId: text('span_id'),
    msg: text('msg').notNull(),
    data: jsonb('data').notNull().default({}),
  },
  (t) => [index('logs_at').on(t.at), index('logs_trace').on(t.traceId)],
);

export const notifications = core.table(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    kind: text('kind').notNull(),
    level: text('level', { enum: ['info', 'success', 'warn', 'error'] }).notNull(),
    title: text('title').notNull(),
    body: text('body'),
    action: jsonb('action'),
    traceId: text('trace_id'),
    readAt: ts('read_at'),
    createdAt: created(),
  },
  (t) => [index('notifications_user_created').on(t.userId, t.createdAt)],
);

export const serviceHealth = core.table('service_health', {
  service: text('service').primaryKey(),
  status: text('status', { enum: ['ok', 'degraded', 'down', 'restarting'] }).notNull(),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastOkAt: ts('last_ok_at'),
  lastError: jsonb('last_error'),
  restarts: jsonb('restarts').notNull().default([]),
  updatedAt: updated(),
});

export const diagnostics = core.table('diagnostics', {
  id: text('id').primaryKey(),
  status: text('status', { enum: ['running', 'passed', 'failed'] }).notNull(),
  results: jsonb('results').notNull().default([]),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
});
