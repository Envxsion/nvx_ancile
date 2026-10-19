-- Thread search (roadmap TS1) matched the stored JSON of each message, so words like "type" or
-- "text" matched everything. search_text is the visible text of a message (its text parts, as the
-- reader sees them), kept by Postgres itself whenever parts change, so no write path can forget it.
create or replace function core.parts_text(parts jsonb) returns text
language sql immutable parallel safe as $$
  select coalesce(string_agg(p.value ->> 'text', ' ' order by p.ord), '')
  from jsonb_array_elements(case when jsonb_typeof(parts) = 'array' then parts else '[]'::jsonb end)
    with ordinality as p(value, ord)
  where p.value ->> 'type' = 'text'
$$;

alter table core.messages
  add column if not exists search_text text generated always as (core.parts_text(parts)) stored;

create index if not exists messages_search_fts
  on core.messages using gin (to_tsvector('simple', search_text));
