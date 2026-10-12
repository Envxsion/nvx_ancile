-- Phase 3 (F): tool presets (docs/scopes.md, Tool presets). The built-in
-- presets (research, coding, read_only) live in packages/contracts and are
-- never stored; this table holds your own. A notebook or thread chooses one
-- with `tool_preset` in its scope patch (core.scopes.patch).
create table if not exists core.tool_presets (
  id text primary key,
  name text not null,
  description text not null default '',
  rules jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- "Which scopes use this preset?" before a delete.
create index if not exists scopes_tool_preset on core.scopes ((patch->>'tool_preset'))
  where patch ? 'tool_preset';
