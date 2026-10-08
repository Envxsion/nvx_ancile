-- ============================================================================
--  Phase 4: memory in use. Proposals carry the entry itself (not only a
--  patch), where it goes, what it replaces and where it came from, so the
--  inbox can show it and the poisoning rule can be checked after the fact.
--  An applied change can be undone, which is a status of its own.
-- ============================================================================

alter table core.memory_proposals add column if not exists section text not null default 'Preferences';
alter table core.memory_proposals add column if not exists text text not null default '';
alter table core.memory_proposals add column if not exists target_key text;
alter table core.memory_proposals add column if not exists target_text text;
alter table core.memory_proposals add column if not exists provenance text not null default 'user_message'
  check (provenance in ('user_message','run_outcome','tool_output','source_content'));

alter table core.memory_proposals drop constraint if exists memory_proposals_status_check;
alter table core.memory_proposals add constraint memory_proposals_status_check
  check (status in ('proposed','applied','rejected','auto_applied','undone'));

create index if not exists memory_proposals_status on core.memory_proposals (status, created_at desc);
create index if not exists memory_entries_path on core.memory_entries (path);
