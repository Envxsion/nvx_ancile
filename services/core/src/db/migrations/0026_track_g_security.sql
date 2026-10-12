-- Track G (Scopes, Auto mode and security).
--
-- 1. MCP tool-list fingerprints (docs/plugins.md, "When a server changes its
--    tools"). One row per server, per origin (NVX Ancile's host, or Claude
--    Code's own servers): the tool list it was approved with (name → SHA-256
--    of the tool's canonical JSON) and, once it changes, what it offers now.
create table if not exists core.mcp_tool_approvals (
  origin text not null check (origin in ('host', 'claude_code')),
  server text not null,
  approved_tools jsonb not null,
  approved_fingerprint text not null,
  approved_at timestamptz not null default now(),
  current_tools jsonb not null,
  current_fingerprint text not null,
  changed_at timestamptz,
  coverage text not null default 'full' check (coverage in ('full', 'names')),
  primary key (origin, server)
);

-- 2. What had already left this machine when a notebook became private or a
--    notebook or thread became local only (docs/scopes.md). Counts per
--    engine or provider and a date range, never content.
create table if not exists core.scope_shared_history (
  id text primary key,
  level text not null check (level in ('notebook', 'thread')),
  ref_id text not null,
  change text not null check (change in ('private', 'local_only')),
  turns integer not null,
  first_at timestamptz,
  last_at timestamptz,
  destinations jsonb not null,
  changed_at timestamptz not null default now()
);
create index if not exists scope_shared_history_ref on core.scope_shared_history (level, ref_id, changed_at desc);
