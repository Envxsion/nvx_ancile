-- NVX Ancile Controller: schema v1 (DESIGN.md §3.3).
-- Kept in step with src/db/schema.ts; later migrations are generated with
-- `pnpm db:generate` and reviewed.

CREATE SCHEMA IF NOT EXISTS controller;

CREATE TABLE controller.nodes (
  id                 text PRIMARY KEY,
  provider           text NOT NULL,
  provider_ref       text NOT NULL,
  name               text NOT NULL,
  gpu_type           text NOT NULL,
  region             text,
  observed_state     text NOT NULL DEFAULT 'unknown',
  desired_state      text NOT NULL DEFAULT 'stopped',
  endpoint_url       text,
  served_models      text[] NOT NULL DEFAULT '{}',
  hourly_rate        real NOT NULL DEFAULT 0,
  storage_rate_month real NOT NULL DEFAULT 0,
  tags               text[] NOT NULL DEFAULT '{}',
  health             jsonb NOT NULL DEFAULT '{}',
  running_since      timestamptz,
  terminated_at      timestamptz,
  last_activity_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);

CREATE TABLE controller.operations (
  id              text PRIMARY KEY,
  node_id         text NOT NULL REFERENCES controller.nodes(id) ON DELETE CASCADE,
  action          text NOT NULL CHECK (action IN ('create','start','stop','restart','terminate')),
  status          text NOT NULL CHECK (status IN ('requested','acknowledged','in_progress','confirmed','failed','timed_out')),
  timeline        jsonb NOT NULL DEFAULT '[]',
  idempotency_key text NOT NULL,
  requested_by    text NOT NULL,
  reason          text,
  error           jsonb,
  trace_id        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX operations_idempotency ON controller.operations (idempotency_key);
CREATE INDEX operations_node ON controller.operations (node_id, created_at);
-- At most one live operation per node, enforced by the database too.
CREATE UNIQUE INDEX operations_one_live_per_node ON controller.operations (node_id)
  WHERE status IN ('requested','acknowledged','in_progress');

CREATE TABLE controller.usage_intervals (
  id          text PRIMARY KEY,
  node_id     text NOT NULL REFERENCES controller.nodes(id) ON DELETE CASCADE,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  hourly_rate real NOT NULL,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX usage_node_started ON controller.usage_intervals (node_id, started_at);
CREATE UNIQUE INDEX usage_one_open_per_node ON controller.usage_intervals (node_id) WHERE ended_at IS NULL;

CREATE TABLE controller.rules (
  id            text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('idle_timeout','schedule','cost_cap')),
  config        jsonb NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  last_fired_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE controller.routes (
  alias   text PRIMARY KEY,
  targets jsonb NOT NULL,
  policy  jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE controller.queued_requests (
  id          text PRIMARY KEY,
  route_alias text NOT NULL,
  node_id     text NOT NULL,
  payload     jsonb,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','dispatched','expired','cancelled')),
  attempts    integer NOT NULL DEFAULT 0,
  deadline_at timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX queued_status ON controller.queued_requests (status, created_at);
