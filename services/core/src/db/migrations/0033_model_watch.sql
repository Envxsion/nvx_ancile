-- MD4, MD5: the daily model watch (docs/models.md).
--
-- model_watch keeps what each provider's live list said, one row per model
-- id. A row is never deleted: a retired model keeps its row so its id still
-- resolves, and a model already seen is never offered as new twice.
-- model_changes is the feed of what changed (new models, prices, context,
-- abilities, retirements, lines moving). Core keeps the newest 200 and drops
-- seen ones older than 30 days on each run.
create table if not exists core.model_watch (
  id text primary key,
  provider text not null,
  data jsonb not null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  missed integer not null default 0
);
create index if not exists model_watch_provider on core.model_watch (provider);

create table if not exists core.model_changes (
  id text primary key,
  kind text not null,
  model_id text not null,
  line_id text,
  before jsonb,
  after jsonb,
  reason text,
  at timestamptz not null default now(),
  seen boolean not null default false
);
create index if not exists model_changes_seen_at on core.model_changes (seen, at);
