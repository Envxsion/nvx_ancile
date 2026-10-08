-- Flows (DESIGN.md §16): graphs that decide how a message is answered.

create table core.flows (
  id text primary key,
  workspace_id text not null,
  scope text not null check (scope in ('workspace','notebook','thread')),
  scope_ref text,
  name text not null,
  description text not null default '',
  graph jsonb not null,
  version integer not null default 1,
  active boolean not null default false,
  -- Answers use this version; later saves are drafts. Null: the latest.
  published_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index flows_scope on core.flows (workspace_id, scope, scope_ref) where deleted_at is null;
-- One active flow per place (the workspace, a notebook, a thread).
create unique index flows_one_active on core.flows (workspace_id, scope, coalesce(scope_ref, ''))
  where active and deleted_at is null;

create table core.flow_versions (
  flow_id text not null references core.flows(id) on delete cascade,
  version integer not null,
  name text not null,
  graph jsonb not null,
  message text,
  created_at timestamptz not null default now(),
  primary key (flow_id, version)
);

-- Every router and rule decision: the confidence heat-map and the close-calls inbox.
create table core.flow_decisions (
  message_id text not null,
  node_id text not null,
  thread_id text not null,
  flow_id text not null,
  version integer not null,
  chose text[] not null,
  scores jsonb,
  confidence real,
  label text,
  at timestamptz not null default now(),
  primary key (message_id, node_id)
);
create index flow_decisions_flow on core.flow_decisions (flow_id, node_id, at desc);

-- The last run of each node, with its exact payload, for the editor.
create table core.flow_node_runs (
  flow_id text not null,
  node_id text not null,
  payload jsonb not null,
  output text not null,
  meta jsonb not null,
  at timestamptz not null default now(),
  primary key (flow_id, node_id)
);

-- "Try a message" runs a flow without writing to a thread.
alter table core.runs drop constraint if exists runs_kind_check;
alter table core.runs add constraint runs_kind_check
  check (kind in ('chat_turn','agent','research','factcheck','automation','diagnostic','flow_try'));
