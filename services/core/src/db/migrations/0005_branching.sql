-- ============================================================================
--  Phase 4: branching. Named heads, compaction summaries reused across
--  branches, and subtree delete with undo.
-- ============================================================================

create index if not exists branches_thread on core.branches (thread_id, created_at)
  where archived_at is null;
create index if not exists branches_head on core.branches (head_message_id);

create index if not exists summaries_thread on core.summaries (thread_id, kind, created_at);

-- A subtree delete stamps every message with the same deleted_at, and Undo
-- restores exactly that batch: this finds it without scanning the thread.
create index if not exists messages_deleted on core.messages (thread_id, deleted_at)
  where deleted_at is not null;
