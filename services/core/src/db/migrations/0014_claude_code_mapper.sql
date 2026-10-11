-- Works with Claude Code, second pass (docs/claude-code.md).
-- claude_code_sessions.mapper_version: which version of the transcript
-- mapping (services/core/src/claudecode/map.ts MAPPER_VERSION) built the
-- thread. Rows from before this migration were built by version 1, and
-- are rebuilt by the next auto-import pass when the thread holds nothing
-- written in NVX Ancile.
-- claude_code_projects.created_notebook: the notebook was made for the
-- folder (not an existing one adopted or chosen), so it may be given a
-- colour, and archived when the folder is excluded and nothing is left in
-- it. Existing rows: a notebook made within seconds of its binding was
-- made by it.
-- Several sessions may share a thread (thread_id was never unique).

alter table core.claude_code_sessions
  add column if not exists mapper_version integer not null default 1;

alter table core.claude_code_projects
  add column if not exists created_notebook boolean not null default false;

update core.claude_code_projects p
  set created_notebook = true
  from core.notebooks n
  where n.id = p.notebook_id
    and n.created_at >= p.created_at - interval '5 seconds'
    and p.created_notebook = false;
