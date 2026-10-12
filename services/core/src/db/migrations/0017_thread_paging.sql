-- Paging long threads (docs/api.md, GET /threads/:id/path?limit=).
-- A path is worked out from the thread's shape alone (id, parent, role,
-- time) before any parts are read, so a 20,000-message thread imported from
-- Claude Code opens without reading every tool result. This index answers
-- that shape in creation order, from the index alone where it can.
create index if not exists messages_thread_shape
  on core.messages (thread_id, created_at, id) include (parent_id, role)
  where deleted_at is null;
