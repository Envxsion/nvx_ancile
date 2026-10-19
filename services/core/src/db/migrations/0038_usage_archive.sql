-- Purged threads keep their spend. Usage is read from stored messages, so purging a thread's
-- messages would erase past spend from Settings > Usage and from the month-to-date budget.
-- Before a purge deletes them, the purge rolls each thread's billed answers up into this table
-- (one row per 15-minute UTC slot, engine, model and provider) and the Usage report adds it back.
-- 15 minutes, not a day, so every local day and hour in every zone still sums the same.
create table if not exists core.usage_archive (
  id bigserial primary key,
  workspace_id text not null references core.workspaces(id),
  bucket_at timestamptz not null,
  engine text not null,
  model_id text,
  provider text,
  input_tokens bigint not null default 0,
  cached_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_usd numeric not null default 0,
  estimated_usd numeric not null default 0,
  answers integer not null default 0,
  archived_at timestamptz not null default now()
);
create index if not exists usage_archive_ws_at on core.usage_archive (workspace_id, bucket_at);
