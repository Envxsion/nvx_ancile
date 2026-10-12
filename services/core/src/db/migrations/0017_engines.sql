-- Engines: one thread, any model (docs/engines.md).
-- engine_sessions: for each Claude Code session NVX Ancile drives, the
-- NVX Ancile compaction summary it has already been given. When the next
-- Claude Code turn on a branch comes after a compaction its session has
-- not seen, the turn starts a fresh session seeded with that summary
-- (NVX Ancile's summary is the one record of a mixed thread), and the new
-- session is recorded here as having seen it. A session is one branch's
-- place in Claude Code, so this is tracked per session.
-- Notebook instructions and persona live in core.notebooks.settings
-- ('ancile'), thread ones in core.threads.settings ('ancile'): no columns.

create table if not exists core.engine_sessions (
  workspace_id text not null references core.workspaces(id),
  session_id text not null,
  thread_id text not null references core.threads(id),
  seen_summary_id text,
  seen_at timestamptz not null default now(),
  primary key (workspace_id, session_id)
);

create index if not exists engine_sessions_thread on core.engine_sessions (thread_id);
