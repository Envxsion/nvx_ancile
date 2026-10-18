-- CA2, CA3, CA4: prompts that start the same way every turn (docs/prompt-caching.md).
--
-- prompt_epochs keeps, per thread and branch, the frozen start of a request:
-- system text, the tools block (as the exact text sent, plus its hash) and
-- the pinned-memory snapshot. An epoch ends only for a reason on a closed
-- list (contracts EPOCH_REASONS). The text columns are text, never jsonb,
-- because jsonb reorders keys and would change the bytes a provider sees.
create table if not exists core.prompt_epochs (
  id text primary key,
  thread_id text not null references core.threads (id),
  reason text not null,
  model_family text not null,
  thinking boolean not null default false,
  system_text text not null,
  tools_json text not null,
  tools_hash text not null,
  memory_commit text,
  memory_text text not null default '',
  track text not null default '{}',
  instructions text not null default '',
  display_name text not null default '',
  compaction_id text,
  started_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create index if not exists prompt_epochs_thread on core.prompt_epochs (thread_id, started_at);

-- sent: the message exactly as it was sent to a model, as text. For a user
-- message, the content string (its context block included); for an assistant
-- message, the provider messages it expands to, as JSON text. Null on older
-- messages, which are rebuilt from their parts as before.
-- epoch_id: the epoch an answer was written in.
alter table core.messages add column if not exists sent text;
alter table core.messages add column if not exists epoch_id text;
