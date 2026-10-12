-- Track G (Claude Code and mixed models).
--
-- 1. One sender per thread at a time, across windows (later a phone), on top
--    of idempotency keys (docs/api.md, "One sender at a time"). A row is the
--    lock: who holds it (a window's random id, never a person or a secret),
--    the run its send started once there is one, and a lease. The lock is
--    free again when its lease ran out before a run was started (a crash or
--    a timeout mid-send), or when the run it started is no longer active.
--    Nothing has to clean it up for it to come free.
create table if not exists core.thread_send_locks (
  thread_id text primary key,
  holder text not null,
  run_id text,
  lease_until timestamptz not null,
  acquired_at timestamptz not null default now()
);

-- 2. One repository in two folders (a git worktree, a WSL path and its
--    Windows path): what the person chose for a pair of folder notebooks
--    (docs/claude-code.md, "One repository in two folders"). The pair is
--    stored in a fixed order (a < b) so it is found from either side.
create table if not exists core.claude_code_repo_pairs (
  notebook_a text not null,
  notebook_b text not null,
  choice text not null check (choice in ('keep_apart', 'show_together')),
  decided_at timestamptz not null default now(),
  primary key (notebook_a, notebook_b),
  check (notebook_a < notebook_b)
);
