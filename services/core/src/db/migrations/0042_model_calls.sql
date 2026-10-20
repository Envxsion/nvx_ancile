-- Every model call that is not a chat answer, so Settings > Usage and the spend caps count it.
-- A chat answer carries its own usage on its message; a fact-check, a memory pass, a title, a
-- decision, a web lookup or a comparison did not, so none of them showed in Usage. One row per
-- finished call, with the purpose it was made for. Rows are small and are not tied to a thread,
-- so purging a thread never changes the totals.
create table if not exists core.model_calls (
  id bigserial primary key,
  workspace_id text not null references core.workspaces(id),
  at timestamptz not null default now(),
  purpose text not null,
  engine text not null default 'gateway',
  model_id text,
  provider text,
  input_tokens bigint not null default 0,
  cached_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_usd numeric not null default 0,
  trace_id text,
  run_id text
);
create index if not exists model_calls_ws_at on core.model_calls (workspace_id, at);
