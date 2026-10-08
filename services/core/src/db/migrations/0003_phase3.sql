-- ============================================================================
--  Phase 3: notebooks and notes in use; threads gain pins, a real archive
--  and a separate delete; message text becomes searchable.
-- ============================================================================

create extension if not exists pg_trgm;

-- Until now DELETE /threads/:id set archived_at. Archive is now something
-- you can browse and restore, and delete is delete: move what was deleted.
alter table core.threads add column if not exists deleted_at timestamptz;
alter table core.threads add column if not exists pinned_at timestamptz;
update core.threads set deleted_at = archived_at, archived_at = null
where archived_at is not null and deleted_at is null;

create index if not exists threads_ws_live_updated on core.threads (workspace_id, updated_at desc)
  where deleted_at is null and archived_at is null;
create index if not exists threads_notebook on core.threads (notebook_id) where deleted_at is null;

alter table core.notebooks add column if not exists pinned_at timestamptz;
alter table core.notebooks add column if not exists deleted_at timestamptz;

alter table core.notes add column if not exists pinned_at timestamptz;
alter table core.notes add column if not exists deleted_at timestamptz;
create index if not exists notes_notebook on core.notes (notebook_id, updated_at desc) where deleted_at is null;

-- "Search inside messages" from the palette: trigram match over the parts.
create index if not exists messages_parts_trgm on core.messages using gin ((parts::text) gin_trgm_ops);
