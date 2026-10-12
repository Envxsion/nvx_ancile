-- Source tombstones (ROADMAP.md track G, docs/sources.md).
-- When a source is deleted, or merged into another, Core keeps one row: its
-- id, title and when it went. Answers that cited it keep their quoted
-- passages in their own parts, so they stay readable; this row lets the
-- Cockpit name the source and say "Source removed" even after the knowledge
-- service has purged the source itself. Rows are never deleted with the
-- source; they are small and say nothing the answers do not already hold.

create table if not exists core.source_tombstones (
  source_id    text primary key,
  workspace_id text not null references core.workspaces(id),
  title        text not null,
  kind         text,
  reason       text not null default 'deleted' check (reason in ('deleted', 'merged')),
  merged_into  text,
  deleted_at   timestamptz not null default now()
);

create index if not exists source_tombstones_workspace
  on core.source_tombstones (workspace_id, deleted_at desc);
