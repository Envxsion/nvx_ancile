-- Phase 5: observability, self-healing, automations, Ancile as an MCP server.

-- Logs: the viewer filters by level, component and time; the tail reads by id.
create index if not exists logs_level_at on core.logs (level, at desc);
create index if not exists logs_component_at on core.logs (component, at desc);
create index if not exists logs_service_at on core.logs (service, at desc);

-- Spans: a trace's waterfall reads by trace; the trace list reads root spans by time.
create index if not exists spans_trace on core.spans (trace_id, start_at);
create index if not exists spans_roots on core.spans (start_at desc) where parent_span_id is null;

-- Automations: what the runner learned on its last go.
alter table core.automations add column if not exists last_error jsonb;
alter table core.automations add column if not exists last_duration_ms integer;
alter table core.automations add column if not exists runs integer not null default 0;

-- Service health: when a service was marked "needs attention", and the fix shown.
alter table core.service_health add column if not exists needs_attention boolean not null default false;
alter table core.service_health add column if not exists remediation text;

-- Apps that use NVX Ancile through MCP. Only a hash of each token is kept;
-- what a client may do is decided by grants on principal 'mcp:<id>'.
create table if not exists core.mcp_clients (
  id text primary key,
  name text not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
