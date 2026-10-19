-- TC3/TC4/RA1: the Trash and the rail's read state.
-- Deleted threads already carry deleted_at (a soft delete); the Trash lists them and the daily purge
-- removes those older than 30 days. seen_at is when a thread was last opened: an answer newer than
-- it is "unread" in the rail, on every device, because the state lives here.
alter table core.threads add column if not exists seen_at timestamptz;
update core.threads set seen_at = now() where seen_at is null;
alter table core.threads alter column seen_at set default now();
create index if not exists threads_trash on core.threads (workspace_id, deleted_at) where deleted_at is not null;
