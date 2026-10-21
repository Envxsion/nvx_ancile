-- Deleting a notebook (docs/notebooks.md, "Deleting a notebook").
--
-- 1. core.threads.placed_at: when a thread last changed notebook (moved, or left a deleted one).
--    Sync reads it beside updated_at, because a move must not touch updated_at (that would
--    reorder the rail), yet another computer still has to hear that the thread left its notebook.
-- 2. core.claude_code_dismissed: a Claude Code folder whose notebook was deleted. Sync neither
--    recreates the notebook nor brings the folder's sessions back in until the person adds the
--    folder again (a folder mapped in Settings, or a session imported by hand).
alter table core.threads add column if not exists placed_at timestamptz;

create table if not exists core.claude_code_dismissed (
  workspace_id text not null references core.workspaces(id),
  cwd_key text not null,
  cwd text not null,
  dismissed_at timestamptz not null default now(),
  primary key (workspace_id, cwd_key)
);
