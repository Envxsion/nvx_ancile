-- Claude Code reliability before v1 (ROADMAP track G, docs/claude-code.md).
--
-- claude_code_unknown_entries: a line of a Claude Code transcript that this
-- version of NVX Ancile does not know (a kind of entry a newer Claude Code
-- writes, a content block it has no part for, or a line that is not JSON).
-- It is never dropped: the thread shows "1 entry this version of NVX Ancile
-- can't show yet", and the line is kept here exactly as read (up to 1 MB,
-- `truncated` when cut), with the Claude Code version that wrote it, so a
-- later version can show it. Keyed by session and entry uuid (a line with
-- no uuid gets a stable one from its content), so reading it again adds
-- nothing.
--
-- engine_source_marks: the notebook's sources as a Claude Code thread last
-- saw them (id → title), so its next turn can be told "2 sources added
-- since your last turn: A, B (1 removed: C)". One row per thread.

create table if not exists core.claude_code_unknown_entries (
  workspace_id text not null references core.workspaces(id),
  session_id text not null,
  uuid text not null,
  thread_id text references core.threads(id) on delete cascade,
  entry_type text not null,
  cli_version text,
  raw text not null,
  truncated boolean not null default false,
  first_seen timestamptz not null default now(),
  primary key (workspace_id, session_id, uuid)
);

create index if not exists claude_code_unknown_entries_thread on core.claude_code_unknown_entries (thread_id);

create table if not exists core.engine_source_marks (
  workspace_id text not null references core.workspaces(id),
  thread_id text not null references core.threads(id) on delete cascade,
  sources jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, thread_id)
);
