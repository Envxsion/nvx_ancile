-- Phase 3 (A): scopes per notebook and thread, private notebooks, and Auto
-- mode's plans (docs/scopes.md, docs/auto-mode.md).

-- A private notebook keeps everything on this machine: local models only,
-- local reviewers only, never Claude Code. It is a floor in scopes/resolve.ts.
alter table core.notebooks add column if not exists private boolean not null default false;

-- One stored patch per notebook or thread. The effective scope is computed,
-- never stored: defaults, the private floor, the notebook, then the thread
-- (which can only narrow).
create table if not exists core.scopes (
  level text not null check (level in ('notebook','thread')),
  ref_id text not null,
  patch jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (level, ref_id)
);

-- Auto mode: a plan is approved once per session (a thread, or a run with no
-- thread); calls that fit an approved step run without asking. Floors and
-- scopes still apply to every call.
create table if not exists core.auto_plans (
  id text primary key,
  session_key text not null,
  run_id text,
  thread_id text,
  summary text not null,
  steps jsonb not null,
  status text not null check (status in ('proposed','approved','rejected','superseded')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists auto_plans_session on core.auto_plans (session_key, created_at desc);
