-- ============================================================================
--  NVX Ancile Core: initial schema (DESIGN.md §3.1)
--  Authoritative over src/db/schema.ts for anything drizzle cannot express.
--  Extensions (vector, pg_trgm) are created by infra/db/init.sql as superuser;
--  the IF NOT EXISTS here is for databases provisioned another way.
-- ============================================================================

create extension if not exists vector;
create schema if not exists core;

-- ---- Identity --------------------------------------------------------------
create table core.users (
  id text primary key,
  display_name text not null,
  email text,
  passphrase_hash text,
  created_at timestamptz not null default now()
);

create table core.workspaces (
  id text primary key,
  name text not null,
  slug text not null unique,
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table core.members (
  workspace_id text not null references core.workspaces(id),
  user_id text not null references core.users(id),
  role text not null check (role in ('owner','editor','viewer')),
  primary key (workspace_id, user_id)
);

-- ---- Notebooks ---------------------------------------------------------------
create table core.notebooks (
  id text primary key,
  workspace_id text not null references core.workspaces(id),
  title text not null,
  slug text not null,
  description text,
  icon text,
  color text,
  memory_path text not null,
  settings jsonb not null default '{}',
  archived_at timestamptz,
  last_opened_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug)
);

create table core.notes (
  id text primary key,
  notebook_id text not null references core.notebooks(id),
  kind text not null check (kind in ('human','ai')),
  title text not null,
  content_md text not null default '',
  from_message_id text,
  from_insight_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---- Threads and the message tree -------------------------------------------
create table core.threads (
  id text primary key,
  workspace_id text not null references core.workspaces(id),
  notebook_id text references core.notebooks(id),
  title text not null default 'New thread',
  title_source text not null default 'auto' check (title_source in ('auto','user')),
  root_message_id text,
  active_head_id text,
  settings jsonb not null default '{}',
  pinned_tldr_id text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index threads_ws_updated on core.threads (workspace_id, updated_at desc);

create table core.messages (
  id text primary key,
  thread_id text not null references core.threads(id),
  parent_id text references core.messages(id),
  role text not null check (role in ('system','user','assistant','tool')),
  parts jsonb not null,
  model_id text,
  requested_model_id text,
  status text not null check (status in ('pending','streaming','complete','stopped','error')),
  edit_of_id text references core.messages(id),
  provenance jsonb not null default '{}',
  usage jsonb,
  run_id text,
  trace_id text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index messages_thread_parent on core.messages (thread_id, parent_id);
create index messages_parent on core.messages (parent_id);

create table core.branches (
  id text primary key,
  thread_id text not null references core.threads(id),
  head_message_id text not null references core.messages(id),
  fork_message_id text not null references core.messages(id),
  name text not null,
  color text not null,
  created_by text not null default 'user' check (created_by in ('user','suggestion')),
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table core.summaries (
  id text primary key,
  thread_id text not null references core.threads(id),
  upto_message_id text not null references core.messages(id),
  kind text not null check (kind in ('tldr','compaction')),
  content text not null,
  tokens integer not null,
  model_id text not null,
  created_at timestamptz not null default now()
);
create index summaries_upto on core.summaries (upto_message_id, kind);

create table core.drafts (
  thread_id text not null,
  parent_id text not null,
  user_id text not null,
  content jsonb not null,
  attachments jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  primary key (thread_id, parent_id, user_id)
);

create table core.ui_state (
  user_id text not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- ---- Durable runs -------------------------------------------------------------
create table core.runs (
  id text primary key,
  kind text not null check (kind in ('chat_turn','agent','research','factcheck','automation','diagnostic')),
  thread_id text,
  message_id text,
  status text not null check (status in ('queued','running','waiting_approval','waiting_compute','succeeded','failed','cancelled')),
  checkpoint jsonb,
  step_cursor integer not null default 0,
  attempt integer not null default 0,
  lease_owner text,
  lease_until timestamptz,
  error jsonb,
  trace_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index runs_status_lease on core.runs (status, lease_until);

create table core.run_steps (
  id text primary key,
  run_id text not null references core.runs(id),
  seq integer not null,
  kind text not null,
  idempotency_key text not null,
  status text not null check (status in ('in_progress','waiting','succeeded','failed','skipped','uncertain')),
  input jsonb,
  output jsonb,
  error jsonb,
  span_id text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (run_id, seq)
);

create table core.run_events (
  run_id text not null,
  seq integer not null,
  type text not null,
  data jsonb not null,
  at timestamptz not null default now(),
  primary key (run_id, seq)
);

-- ---- Permissions -----------------------------------------------------------------
create table core.grants (
  id text primary key,
  user_id text not null,
  principal text not null,
  action_pattern text not null,
  resource_pattern text not null,
  effect text not null check (effect in ('allow','deny')),
  tier text not null default 'gated' check (tier = 'gated'),
  scope text not null check (scope in ('thread','notebook','workspace','always')),
  scope_ref text,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_from_approval_id text,
  uses integer not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index grants_active on core.grants (user_id, principal) where revoked_at is null;

create table core.approvals (
  id text primary key,
  run_id text not null references core.runs(id),
  step_seq integer not null,
  principal text not null,
  tool text not null,
  action text not null,
  resource text not null,
  args_preview jsonb,
  tier text not null check (tier in ('gated','critical')),
  status text not null check (status in ('pending','approved','denied','expired','cancelled')),
  decision_scope text,
  decision_pattern text,
  decided_by text,
  decided_at timestamptz,
  reason text,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index approvals_pending on core.approvals (status) where status = 'pending';

-- Append-only: no updates or deletes from the application role.
create table core.decisions (
  id text primary key,
  at timestamptz not null default now(),
  user_id text not null,
  principal text not null,
  action text not null,
  resource text not null,
  tier text not null check (tier in ('auto','gated','critical')),
  outcome text not null check (outcome in ('auto','grant','approved','denied','policy_deny','expired')),
  grant_id text,
  approval_id text,
  policy_id text,
  run_id text,
  trace_id text not null
);
create index decisions_at on core.decisions (at desc);

create or replace function core.forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'core.decisions is append-only';
end $$;
create trigger decisions_append_only before update or delete on core.decisions
  for each row execute function core.forbid_mutation();

-- ---- Memory (derived) -------------------------------------------------------------
create table core.memory_entries (
  id text primary key,
  path text not null,
  scope text not null,
  notebook_id text,
  entry_key text not null,
  text text not null,
  meta jsonb not null default '{}',
  embedding vector,
  commit_sha text not null,
  valid_from timestamptz,
  superseded_by text,
  updated_at timestamptz not null default now(),
  unique (path, entry_key)
);
-- Vector index per embedding model, created by the indexer once the dimension
-- is known, e.g. (for the default 384-d local embedder):
--   create index memory_entries_emb_384 on core.memory_entries
--     using hnsw ((embedding::vector(384)) vector_cosine_ops)
--     where meta->>'embed_model' = 'BAAI/bge-small-en-v1.5';

create table core.memory_proposals (
  id text primary key,
  kind text not null check (kind in ('preference','failure_lesson','project_finding','model_quirk','manual')),
  target_path text not null,
  op text not null check (op in ('add','update','supersede')),
  patch text not null,
  rationale text not null,
  evidence jsonb not null default '[]',
  confidence real not null,
  status text not null check (status in ('proposed','applied','rejected','auto_applied')),
  commit_sha text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

-- ---- Models -----------------------------------------------------------------------------
create table core.models (
  id text primary key,
  provider text not null,
  provider_model text not null,
  display_name text not null,
  via text not null check (via in ('direct','controller')),
  context_window integer not null,
  max_output integer not null,
  capabilities text[] not null default '{}',
  family text not null,
  price_in double precision not null default 0,
  price_out double precision not null default 0,
  price_cached double precision,
  enabled boolean not null default true,
  config jsonb not null default '{}'
);

create table core.model_stats (
  model_id text not null,
  task_class text not null,
  window_start timestamptz not null,
  calls integer not null default 0,
  successes integer not null default 0,
  refusals integer not null default 0,
  fallbacks_from integer not null default 0,
  p50_ms integer,
  p95_ms integer,
  thumbs_up integer not null default 0,
  thumbs_down integer not null default 0,
  factcheck_mean real,
  primary key (model_id, task_class, window_start)
);

-- ---- Fact-checking --------------------------------------------------------------------------
create table core.factchecks (
  id text primary key,
  message_id text not null references core.messages(id),
  status text not null check (status in ('running','done','failed')),
  confidence real,
  verifier_model_id text,
  run_id text,
  created_at timestamptz not null default now()
);

create table core.claims (
  id text primary key,
  factcheck_id text not null references core.factchecks(id),
  text text not null,
  char_start integer not null,
  char_end integer not null,
  importance real not null default 1,
  verdict text not null check (verdict in ('verified','unverified','contradicted','not_checkable')),
  confidence real not null,
  support real not null,
  agreement real not null,
  retrieval real not null,
  evidence jsonb not null default '[]',
  rationale text
);

-- ---- Tools and integrations ------------------------------------------------------------------
create table core.mcp_servers (
  id text primary key,
  name text not null unique,
  transport text not null check (transport in ('stdio','http')),
  command text,
  args jsonb not null default '[]',
  url text,
  env_secret_ids text[] not null default '{}',
  oauth jsonb,
  enabled boolean not null default true,
  tool_overrides jsonb not null default '{}',
  health jsonb
);

create table core.secrets (
  id text primary key,
  name text not null unique,
  ciphertext bytea not null,
  nonce bytea not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create table core.personas (
  id text primary key,
  name text not null,
  system_prompt_path text not null,
  default_model_id text,
  tools text[] not null default '{}',
  memory_scope text not null default 'workspace',
  created_at timestamptz not null default now()
);

create table core.automations (
  id text primary key,
  kind text not null,
  cron text,
  config jsonb not null default '{}',
  enabled boolean not null default true,
  last_run_at timestamptz,
  last_status text,
  next_run_at timestamptz
);

-- ---- Observability ---------------------------------------------------------------------------
-- TODO(phase-5): range-partition spans and logs by day; retention drops partitions.
create table core.spans (
  trace_id text not null,
  span_id text not null,
  parent_span_id text,
  service text not null,
  name text not null,
  kind text not null,
  start_at timestamptz not null,
  end_at timestamptz,
  status text not null,
  attrs jsonb not null default '{}',
  events jsonb not null default '[]',
  primary key (trace_id, span_id)
);
create index spans_start on core.spans (start_at);

create table core.logs (
  id bigserial primary key,
  at timestamptz not null default now(),
  level text not null,
  service text not null,
  component text,
  trace_id text,
  span_id text,
  msg text not null,
  data jsonb not null default '{}'
);
create index logs_at on core.logs (at desc);
create index logs_trace on core.logs (trace_id);

create table core.notifications (
  id text primary key,
  user_id text not null,
  kind text not null,
  level text not null check (level in ('info','success','warn','error')),
  title text not null,
  body text,
  action jsonb,
  trace_id text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_created on core.notifications (user_id, created_at desc);

create table core.service_health (
  service text primary key,
  status text not null check (status in ('ok','degraded','down','restarting')),
  consecutive_failures integer not null default 0,
  last_ok_at timestamptz,
  last_error jsonb,
  restarts jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

create table core.diagnostics (
  id text primary key,
  status text not null check (status in ('running','passed','failed')),
  results jsonb not null default '[]',
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
