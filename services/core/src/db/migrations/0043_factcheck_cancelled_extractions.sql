-- A fact-check the person stopped reads cancelled, as its run does (it used to read failed with the
-- code run.cancelled). And the claims found in an answer are kept per message, so a check run again
-- reuses them instead of finding a different set (a model's extraction is not repeatable).
alter table core.factchecks drop constraint if exists factchecks_status_check;
alter table core.factchecks
  add constraint factchecks_status_check check (status in ('running', 'done', 'failed', 'cancelled'));
-- Checks that were stopped before this existed.
update core.factchecks set status = 'cancelled'
  where status = 'failed' and error ->> 'code' = 'run.cancelled';

-- One row per message: the claims found in this exact text (answer_sha) by this version of the
-- extraction (version). A changed answer, or a newer extraction, is a miss.
create table if not exists core.factcheck_extractions (
  message_id text primary key references core.messages(id),
  answer_sha text not null,
  version integer not null,
  claims jsonb not null,
  created_at timestamptz not null default now()
);
