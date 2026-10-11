-- Live Claude Code sessions (docs/claude-code.md, phase 2).
-- A turn sent from NVX Ancile into the person's own Claude Code is a run of
-- kind 'claude_code': it has a trace, a status, Stop, and shows in Admin.
-- A thread may now hold several Claude Code sessions: a branch made in
-- Ancile forks the session, and the fork is bound to the same thread
-- (claude_code_sessions.thread_id was never unique).

alter table core.runs drop constraint if exists runs_kind_check;
alter table core.runs add constraint runs_kind_check
  check (kind in ('chat_turn','agent','research','factcheck','automation','diagnostic','flow_try','claude_code'));
