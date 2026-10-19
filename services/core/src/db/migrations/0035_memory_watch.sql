-- M8: a lesson seen once waits as a watch item with its uncertainty written in,
-- becomes a rule on a second sighting, and lapses after 90 days if never seen again.
alter table core.memory_proposals add column if not exists sightings int not null default 1;
alter table core.memory_proposals add column if not exists expires_at timestamptz;
alter table core.memory_proposals add column if not exists uncertainty text;

alter table core.memory_proposals drop constraint if exists memory_proposals_status_check;
alter table core.memory_proposals add constraint memory_proposals_status_check
  check (status in ('proposed','applied','rejected','auto_applied','undone','watching','expired'));
