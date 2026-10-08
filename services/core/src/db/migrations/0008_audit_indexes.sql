-- Round 2 audit: indexes for queries that ran as sequential scans.

-- "Why did it say this?" reads every permission decision for one run.
create index if not exists decisions_run on core.decisions (run_id, at);

-- The memory inbox lists proposals newest first without a status filter.
create index if not exists memory_proposals_created on core.memory_proposals (created_at desc, id desc);
