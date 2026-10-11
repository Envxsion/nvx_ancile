-- Works with Claude Code (docs/claude-code.md).
-- claude_code_projects: a folder's notebook, so a project's sessions land
-- together. cwd_key is the folder compared the way the OS compares paths
-- (lower-case with backslashes on Windows); cwd is kept exactly as Claude
-- Code recorded it.
-- claude_code_sessions: the thread each session was brought into, the
-- title Ancile last gave it (so a rename in Ancile is never overwritten)
-- and the transcript's modified time at the last sync.
-- Which transcript entries a message holds lives on the message itself
-- (provenance.claude_code.uuids), written in the same insert.

create table if not exists core.claude_code_projects (
  workspace_id text not null references core.workspaces(id),
  cwd_key text not null,
  cwd text not null,
  notebook_id text not null references core.notebooks(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, cwd_key)
);

create table if not exists core.claude_code_sessions (
  workspace_id text not null references core.workspaces(id),
  session_id text not null,
  thread_id text not null references core.threads(id),
  title text,
  cwd text,
  last_modified bigint not null default 0,
  synced_at timestamptz not null default now(),
  primary key (workspace_id, session_id)
);
create index if not exists claude_code_sessions_thread on core.claude_code_sessions (thread_id);
