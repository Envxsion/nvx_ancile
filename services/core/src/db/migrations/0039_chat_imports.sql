-- Chats brought in from ChatGPT, Claude or Open WebUI (ROADMAP SU1).
-- chat_imports: one row per file the person brought in, with progress. A job that was running when
-- NVX Ancile stopped carries on from "done" (the conversations already looked at).
-- chat_import_items: which of the tool's own conversation ids became which thread, so the same
-- conversation is never brought in twice, whether it comes again in this file or a later export.
create table if not exists core.chat_imports (
  id text primary key,
  workspace_id text not null references core.workspaces(id),
  origin text not null,
  file_name text,
  file_path text not null,
  status text not null default 'queued',
  total integer not null default 0,
  done integer not null default 0,
  imported integer not null default 0,
  duplicates integer not null default 0,
  empty integer not null default 0,
  messages integer not null default 0,
  notebook_id text,
  error jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists chat_imports_ws_started on core.chat_imports (workspace_id, started_at desc);

create table if not exists core.chat_import_items (
  workspace_id text not null references core.workspaces(id),
  origin text not null,
  source_id text not null,
  thread_id text not null,
  import_id text not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, origin, source_id)
);
