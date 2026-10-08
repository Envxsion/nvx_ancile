/**
 * ------------------------------------------------------------------
 *  Title    |  The controller schema
 *  Ref      |  DESIGN.md §3.3
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  Everything the Controller owns, in its own Postgres
 *           |  schema. Nothing else writes here; Core only ever talks
 *           |  to the Controller over HTTP.
 * ------------------------------------------------------------------
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const controller = pgSchema('controller');

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const nodes = controller.table('nodes', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  providerRef: text('provider_ref').notNull(),
  name: text('name').notNull(),
  gpuType: text('gpu_type').notNull(),
  region: text('region'),
  observedState: text('observed_state').notNull().default('unknown'),
  desiredState: text('desired_state').notNull().default('stopped'),
  endpointUrl: text('endpoint_url'),
  servedModels: text('served_models').array().notNull().default(sql`'{}'::text[]`),
  hourlyRate: real('hourly_rate').notNull().default(0),
  storageRateMonth: real('storage_rate_month').notNull().default(0),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  health: jsonb('health').notNull().default({}),
  runningSince: ts('running_since'),
  terminatedAt: ts('terminated_at'),
  lastActivityAt: ts('last_activity_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const operations = controller.table(
  'operations',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    status: text('status').notNull(),
    timeline: jsonb('timeline').notNull().default([]),
    idempotencyKey: text('idempotency_key').notNull(),
    requestedBy: text('requested_by').notNull(),
    reason: text('reason'),
    error: jsonb('error'),
    traceId: text('trace_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('operations_idempotency').on(t.idempotencyKey),
    index('operations_node').on(t.nodeId, t.createdAt),
  ],
);

export const usageIntervals = controller.table(
  'usage_intervals',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at'),
    hourlyRate: real('hourly_rate').notNull(),
  },
  (t) => [index('usage_node_started').on(t.nodeId, t.startedAt)],
);

export const rules = controller.table('rules', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  config: jsonb('config').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  lastFiredAt: ts('last_fired_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const routes = controller.table('routes', {
  alias: text('alias').primaryKey(),
  targets: jsonb('targets').notNull(),
  policy: jsonb('policy').notNull().default({}),
});

export const queuedRequests = controller.table(
  'queued_requests',
  {
    id: text('id').primaryKey(),
    routeAlias: text('route_alias').notNull(),
    nodeId: text('node_id').notNull(),
    payload: jsonb('payload'),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    deadlineAt: ts('deadline_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('queued_status').on(t.status, t.createdAt)],
);
