-- ============================================================================
--  Phase 4: fact-checks as durable runs (DESIGN.md §10). A fact-check keeps
--  where its evidence came from, how it ended, and its claims in order.
-- ============================================================================

alter table core.factchecks add column if not exists scope jsonb not null default '{}';
alter table core.factchecks add column if not exists error jsonb;
alter table core.factchecks add column if not exists finished_at timestamptz;

create index if not exists factchecks_message on core.factchecks (message_id, created_at desc);

alter table core.claims add column if not exists seq integer not null default 0;
create index if not exists claims_factcheck on core.claims (factcheck_id, seq);
