-- Track E (ROADMAP final run): memory import, and two records engine usage
-- insights read.
--
-- 1. Memory import (docs/memory.md, "Import and export"). Entries brought in
--    from an export are proposals of kind 'imported' with provenance
--    'import': outside content, so they always wait for a yes. Each import
--    is one row here; its proposals point at it.
alter table core.memory_proposals drop constraint if exists memory_proposals_kind_check;
alter table core.memory_proposals add constraint memory_proposals_kind_check
  check (kind in ('preference','failure_lesson','project_finding','model_quirk','manual','imported'));
alter table core.memory_proposals drop constraint if exists memory_proposals_provenance_check;
alter table core.memory_proposals add constraint memory_proposals_provenance_check
  check (provenance in ('user_message','run_outcome','tool_output','source_content','import'));

create table if not exists core.memory_imports (
  id text primary key,
  origin text not null check (origin in ('ancile','claude_code','chatgpt','markdown')),
  label text not null,
  -- The picked file's name only, never a path on this computer.
  filename text,
  created_at timestamptz not null default now()
);

alter table core.memory_proposals add column if not exists import_id text references core.memory_imports(id);
create index if not exists memory_proposals_import on core.memory_proposals (import_id) where import_id is not null;

-- 2. Claude Code plan-limit samples (docs/claude-code.md, "Usage"): the share
--    of each plan window used, kept whenever Claude Code reports a changed
--    figure, so headroom can be shown over time. No account, no content.
create table if not exists core.plan_limit_samples (
  id bigserial primary key,
  window_id text not null,
  kind text not null check (kind in ('session','week','week_model','other')),
  label text,
  percent real not null check (percent >= 0 and percent <= 100),
  resets_at timestamptz,
  at timestamptz not null default now()
);
create index if not exists plan_limit_samples_at on core.plan_limit_samples (at);
