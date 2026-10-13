-- Phase 3 (D): images in threads (docs/images.md).
--
-- The bytes live in the workspace data folder, one file per sha256
-- (<data>/images/<aa>/<sha256>), so the same picture attached twice is kept
-- once. This table is the index: one row per use of a picture in a thread.
-- A thread's rows go with it (cascade); a file no row names any more is
-- removed by the store's sweep.
create table if not exists core.images (
  id text primary key,
  thread_id text references core.threads(id) on delete cascade,
  sha256 text not null,
  mime text not null,
  bytes integer not null,
  width integer,
  height integer,
  source text not null check (source in ('generated', 'attached', 'model_output')),
  alt text not null default '',
  prompt text,
  model text,
  provider text,
  provider_kind text check (provider_kind is null or provider_kind in ('cloud', 'local', 'node')),
  cost_usd numeric(12, 6),
  call_id text,
  created_at timestamptz not null default now()
);
create index if not exists images_thread on core.images (thread_id);
create index if not exists images_sha on core.images (sha256);

-- Hosts whose images the person chose to load, remembered per notebook (or
-- per thread for a thread outside any notebook): scope_key is the notebook
-- id or 'thread:<id>'.
create table if not exists core.image_remote_hosts (
  scope_key text not null,
  host text not null,
  allowed_at timestamptz not null default now(),
  primary key (scope_key, host)
);
