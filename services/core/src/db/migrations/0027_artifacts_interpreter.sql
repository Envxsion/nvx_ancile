-- Phase 3 (B): artifacts and the code interpreter (docs/artifacts.md,
-- docs/interpreter.md).
--
-- Artifacts themselves live in the answers that wrote them (core.messages
-- parts); this table only remembers what the person decided for one: an
-- artifact (a thread and its key) may reach the network only after they
-- turned "Allow network" on, and the decision is kept with when it was made.
create table if not exists core.artifact_settings (
  thread_id text not null references core.threads(id) on delete cascade,
  artifact_key text not null,
  allow_network boolean not null default false,
  changed_at timestamptz not null default now(),
  primary key (thread_id, artifact_key)
);

-- Figures a python_run drew (matplotlib, PNG). The tool result the model
-- reads names them by id; the Cockpit shows them from here.
create table if not exists core.interpreter_figures (
  id text primary key,
  thread_id text references core.threads(id) on delete cascade,
  call_id text,
  png bytea not null,
  width integer not null,
  height integer not null,
  created_at timestamptz not null default now()
);
create index if not exists interpreter_figures_thread on core.interpreter_figures (thread_id);
