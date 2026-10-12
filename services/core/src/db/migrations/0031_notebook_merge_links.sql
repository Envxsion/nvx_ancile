-- Phase 3 (C): notebook merge and context links (docs/notebooks.md).
--
-- notebook_merges: one row per merge of a notebook into another. `record`
-- holds what moved and what each place held before (threads, notes, flows,
-- Claude Code folders, links, the scope and instructions of the notebook
-- merged into, the knowledge service's own record, the memory commit), so
-- the merge can be undone until `undo_until`. It is the merge's history and
-- is kept after an undo (undone_at set).
create table if not exists core.notebook_merges (
  id text primary key,
  workspace_id text not null references core.workspaces(id),
  into_id text not null references core.notebooks(id),
  from_id text not null references core.notebooks(id),
  from_title text not null,
  record jsonb not null,
  merged_at timestamptz not null default now(),
  undo_until timestamptz not null,
  undone_at timestamptz
);
create index if not exists notebook_merges_into on core.notebook_merges (into_id, merged_at desc);
create index if not exists notebook_merges_from on core.notebook_merges (from_id);

-- A notebook merged away is soft-deleted and says where it went.
alter table core.notebooks add column if not exists merged_into text;

-- context_links: a thread or notebook (from) may draw on another's context
-- (to): a notebook's sources, or a thread's summary. Directional; listed on
-- both ends. Every read across one is checked against both scopes when it
-- happens, never when the link was made.
create table if not exists core.context_links (
  id text primary key,
  workspace_id text not null references core.workspaces(id),
  from_kind text not null check (from_kind in ('thread', 'notebook')),
  from_id text not null,
  to_kind text not null check (to_kind in ('thread', 'notebook')),
  to_id text not null,
  kind text not null check (kind in ('sources', 'summary')),
  created_at timestamptz not null default now(),
  check (not (from_kind = to_kind and from_id = to_id)),
  check ((to_kind = 'notebook' and kind = 'sources') or (to_kind = 'thread' and kind = 'summary'))
);
create unique index if not exists context_links_pair on core.context_links (from_kind, from_id, to_kind, to_id);
create index if not exists context_links_to on core.context_links (to_kind, to_id);
