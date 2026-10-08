-- ============================================================================
--  Run safety: one live run per thread, one approval per tool call, and no
--  approvals left pending for runs that already ended.
-- ============================================================================

-- A thread can have older duplicates from before this rule: keep the newest
-- live run of each thread and cancel the rest.
update core.runs r set status = 'cancelled', lease_owner = null, lease_until = null, updated_at = now()
where r.thread_id is not null
  and r.status in ('queued','running','waiting_approval','waiting_compute')
  and exists (
    select 1 from core.runs n
    where n.thread_id = r.thread_id
      and n.status in ('queued','running','waiting_approval','waiting_compute')
      and (n.created_at, n.id) > (r.created_at, r.id)
  );

-- Two sends at once can no longer start two runs on one thread.
create unique index if not exists runs_one_active_per_thread on core.runs (thread_id)
  where status in ('queued','running','waiting_approval','waiting_compute');

-- Asking twice for the same call (a crash between asking and pausing) reuses
-- the first approval. Older duplicates keep their history under a new key.
update core.approvals a set call_id = a.call_id || ':dup:' || a.id
where a.call_id is not null
  and exists (
    select 1 from core.approvals o
    where o.run_id = a.run_id and o.call_id = a.call_id
      and (o.created_at, o.id) < (a.created_at, a.id)
  );
create unique index if not exists approvals_one_per_call on core.approvals (run_id, call_id);

-- One-off clean-up: a pending approval whose run already ended can never be
-- answered usefully. The reconciler keeps this true from now on.
update core.approvals a set status = 'cancelled', decided_at = now()
from core.runs r
where r.id = a.run_id and a.status = 'pending'
  and r.status in ('succeeded','failed','cancelled');
