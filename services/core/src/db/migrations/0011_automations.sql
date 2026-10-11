-- Automations you can change (docs/configuration.md#automations).
-- Built-in jobs keep automations.yaml as their default; a schedule or setting
-- changed in Admin is kept here (customised) and survives a restart, because
-- the file is read-only on the desktop. Your own automations live here only.

alter table core.automations add column if not exists origin text not null default 'builtin';
alter table core.automations drop constraint if exists automations_origin_check;
alter table core.automations add constraint automations_origin_check check (origin in ('builtin', 'user'));
alter table core.automations add column if not exists title text;
alter table core.automations add column if not exists customised boolean not null default false;
alter table core.automations add column if not exists last_detail text;
alter table core.automations add column if not exists last_href text;
alter table core.automations add column if not exists created_at timestamptz not null default now();
