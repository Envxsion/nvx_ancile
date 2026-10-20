-- Tier-aware fact-checks (TR3) and the verdict cache (SI1).
--
-- check_info says how each claim was checked: the tier and model used, where it was sent up a tier,
-- whether the verdict came from the cache, and where routing had to settle for less.
alter table core.claims add column if not exists check_info jsonb;

-- A verdict worth reusing: key is a hash of the normalised claim, the fingerprints of the sources it
-- was checked against, and the mode. A source that changed has a new fingerprint, so its old verdict
-- is never found. Verdicts stay in the notebook that made them (scope 'notebook'); "make these checks
-- global" moves a notebook's source-free verdicts to scope 'global', and "stop sharing" moves them back.
-- notebook_id is '' for a chat outside any notebook.
create table if not exists core.verdict_cache (
  notebook_id text not null,
  key text not null,
  scope text not null default 'notebook' check (scope in ('notebook', 'global')),
  verdict jsonb not null,
  tier text,
  model_id text,
  mode text not null,
  -- source: valid until a source fingerprint changes (it is part of the key). web: a week. rules: 90 days.
  ttl_kind text not null check (ttl_kind in ('source', 'web', 'rules')),
  -- Checked against the person's own sources: never shared, whatever the scope says.
  source_backed boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  primary key (notebook_id, key)
);
create index if not exists verdict_cache_global
  on core.verdict_cache (key) where scope = 'global';
