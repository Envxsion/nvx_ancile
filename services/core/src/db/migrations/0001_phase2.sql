-- ============================================================================
--  Phase 2: chat, routing and permissions.
-- ============================================================================

-- Small typed settings that are not files a person edits: onboarding state,
-- the chosen permission preset, models switched on by a passing key test.
create table if not exists core.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- What a paused tool call needs to resume after a restart, and what the
-- approval dialog shows. args is the exact input the tool will run with.
alter table core.approvals
  add column if not exists thread_id text,
  add column if not exists call_id text,
  add column if not exists args jsonb,
  add column if not exists suggestions jsonb not null default '[]';

create index if not exists approvals_run on core.approvals (run_id);
create index if not exists messages_run on core.messages (run_id);
create index if not exists runs_thread on core.runs (thread_id, created_at desc);
