-- Terminal forks as branches (docs/claude-code.md, phase 2).
-- A session forked in a terminal (/branch) shares its first entries' uuids
-- with the session it came from. When such a session is first brought in,
-- Core looks those uuids up (claudecode/store.ts threadHolding) to hang it
-- off the thread it came from instead of making a new thread. This index
-- keeps that lookup off a full scan of every message.

create index if not exists messages_claude_code_uuids_idx
  on core.messages using gin ((provenance->'claude_code'->'uuids'))
  where provenance ? 'claude_code';
