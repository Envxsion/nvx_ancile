/**
 * ------------------------------------------------------------------
 *  Title    |  Postgres store
 *  Ref      |  DESIGN.md §3.3 · migrations/0000_init.sql
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  The Store interface over the controller schema, so
 *           |  nodes, operations, usage, rules and routes survive a
 *           |  restart and costs stay true across a month.
 *  How      |  postgres.js, one small pool. Every write also emits on
 *           |  `events` in this process, which feeds the SSE streams.
 *  Note     |  One Controller process per database (single user). If
 *           |  it is ever run with replicas, events move to LISTEN /
 *           |  NOTIFY and the rule runner needs leader election.
 * ------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { NodeState, Operation, Rule } from '@nvx/contracts/controller';
import type { Sql } from 'postgres';
import type { UsageInterval } from './costs/compute';
import type { NodeRecord, QueuedRequest, RouteRecord, Store, StoreEvent } from './store';

interface NodeRow {
  id: string;
  provider: string;
  provider_ref: string;
  name: string;
  gpu_type: string;
  region: string | null;
  observed_state: NodeState;
  desired_state: NodeState;
  endpoint_url: string | null;
  served_models: string[];
  hourly_rate: number;
  storage_rate_month: number;
  health: { healthy?: boolean };
  running_since: Date | null;
  terminated_at: Date | null;
  last_activity_at: Date | null;
  created_at: Date;
}

const toNode = (r: NodeRow): NodeRecord => ({
  id: r.id,
  provider: r.provider,
  provider_ref: r.provider_ref,
  name: r.name,
  gpu_type: r.gpu_type,
  region: r.region,
  observed_state: r.observed_state,
  desired_state: r.desired_state,
  endpoint_url: r.endpoint_url,
  served_models: r.served_models,
  hourly_rate: Number(r.hourly_rate),
  storage_rate_month: Number(r.storage_rate_month),
  healthy: Boolean(r.health?.healthy),
  last_activity_at: r.last_activity_at ? r.last_activity_at.toISOString() : null,
  createdAt: r.created_at,
  terminatedAt: r.terminated_at,
  runningSince: r.running_since,
});

interface OpRow {
  id: string;
  node_id: string;
  action: Operation['action'];
  status: Operation['status'];
  timeline: Operation['timeline'];
  requested_by: string;
  reason: string | null;
  error: Operation['error'];
  trace_id: string;
  created_at: Date;
  updated_at: Date;
}

const toOp = (r: OpRow): Operation => ({
  id: r.id,
  node_id: r.node_id,
  action: r.action,
  status: r.status,
  timeline: r.timeline,
  requested_by: r.requested_by,
  reason: r.reason,
  error: r.error,
  trace_id: r.trace_id,
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
});

export class PgStore implements Store {
  readonly events = new EventEmitter<{ event: [StoreEvent] }>();

  constructor(private readonly sql: Sql) {
    this.events.setMaxListeners(200);
  }

  async listNodes() {
    const rows = await this.sql<NodeRow[]>`select * from controller.nodes order by created_at`;
    return rows.map(toNode);
  }

  async getNode(id: string) {
    const [r] = await this.sql<NodeRow[]>`select * from controller.nodes where id = ${id}`;
    return r ? toNode(r) : undefined;
  }

  async putNode(n: NodeRecord) {
    const health = { healthy: n.healthy };
    await this.sql`
      insert into controller.nodes (id, provider, provider_ref, name, gpu_type, region, observed_state,
        desired_state, endpoint_url, served_models, hourly_rate, storage_rate_month, health,
        running_since, terminated_at, last_activity_at, created_at, updated_at)
      values (${n.id}, ${n.provider}, ${n.provider_ref}, ${n.name}, ${n.gpu_type}, ${n.region},
        ${n.observed_state}, ${n.desired_state}, ${n.endpoint_url}, ${this.sql.array(n.served_models)},
        ${n.hourly_rate}, ${n.storage_rate_month}, ${this.sql.json(health)}, ${n.runningSince},
        ${n.terminatedAt}, ${n.last_activity_at ? new Date(n.last_activity_at) : null}, ${n.createdAt}, now())
      on conflict (id) do update set
        name = excluded.name, gpu_type = excluded.gpu_type, region = excluded.region,
        observed_state = excluded.observed_state, desired_state = excluded.desired_state,
        endpoint_url = excluded.endpoint_url, served_models = excluded.served_models,
        hourly_rate = excluded.hourly_rate, storage_rate_month = excluded.storage_rate_month,
        health = excluded.health, running_since = excluded.running_since,
        terminated_at = excluded.terminated_at, last_activity_at = excluded.last_activity_at,
        updated_at = now()`;
    this.events.emit('event', { type: 'node', node: n });
  }

  async deleteNode(id: string) {
    const r = await this.sql`delete from controller.nodes where id = ${id}`;
    await this
      .sql`delete from controller.routes where targets @> ${this.sql.json([{ node_id: id }] as never)}`;
    return r.count > 0;
  }

  async getOperation(id: string) {
    const [r] = await this.sql<OpRow[]>`select * from controller.operations where id = ${id}`;
    return r ? toOp(r) : undefined;
  }

  async findOperationByKey(key: string) {
    const [r] = await this.sql<OpRow[]>`select * from controller.operations where idempotency_key = ${key}`;
    return r ? toOp(r) : undefined;
  }

  async liveOperationFor(nodeId: string) {
    const [r] = await this.sql<OpRow[]>`
      select * from controller.operations
      where node_id = ${nodeId} and status in ('requested','acknowledged','in_progress')
      limit 1`;
    return r ? toOp(r) : undefined;
  }

  async putOperation(op: Operation, idempotencyKey?: string) {
    await this.sql`
      insert into controller.operations (id, node_id, action, status, timeline, idempotency_key,
        requested_by, reason, error, trace_id, created_at, updated_at)
      values (${op.id}, ${op.node_id}, ${op.action}, ${op.status}, ${this.sql.json(op.timeline)},
        ${idempotencyKey ?? `op:${op.id}`}, ${op.requested_by}, ${op.reason},
        ${op.error ? this.sql.json(op.error) : null}, ${op.trace_id}, ${op.created_at}, ${op.updated_at})
      on conflict (id) do update set
        status = excluded.status, timeline = excluded.timeline, error = excluded.error,
        updated_at = excluded.updated_at`;
    this.events.emit('event', { type: 'operation', op });
  }

  async listOperations(nodeId: string, limit = 20) {
    const rows = await this.sql<OpRow[]>`
      select * from controller.operations where node_id = ${nodeId}
      order by created_at desc limit ${limit}`;
    return rows.map(toOp);
  }

  async listRules() {
    const rows = await this.sql<{ id: string; kind: Rule['kind']; config: unknown; enabled: boolean }[]>`
      select id, kind, config, enabled from controller.rules order by created_at`;
    return rows.map((r) => ({ id: r.id, kind: r.kind, enabled: r.enabled, config: r.config }) as Rule);
  }

  async putRule(rule: Rule) {
    await this.sql`
      insert into controller.rules (id, kind, config, enabled)
      values (${rule.id}, ${rule.kind}, ${this.sql.json(rule.config as never)}, ${rule.enabled})
      on conflict (id) do update set kind = excluded.kind, config = excluded.config, enabled = excluded.enabled`;
  }

  async deleteRule(id: string) {
    const r = await this.sql`delete from controller.rules where id = ${id}`;
    return r.count > 0;
  }

  async ruleFiredAt(id: string): Promise<Date | null> {
    const [r] = await this.sql<{ last_fired_at: Date | null }[]>`
      select last_fired_at from controller.rules where id = ${id}`;
    return r?.last_fired_at ?? null;
  }

  async markRuleFired(id: string, at: Date) {
    await this.sql`update controller.rules set last_fired_at = ${at} where id = ${id}`;
  }

  async listRoutes() {
    const rows = await this.sql<
      RouteRecord[]
    >`select alias, targets, policy from controller.routes order by alias`;
    return rows.map((r) => ({ alias: r.alias, targets: r.targets, policy: r.policy }));
  }

  async putRoute(route: RouteRecord) {
    await this.sql`
      insert into controller.routes (alias, targets, policy)
      values (${route.alias}, ${this.sql.json(route.targets as never)}, ${this.sql.json(route.policy as never)})
      on conflict (alias) do update set targets = excluded.targets, policy = excluded.policy`;
  }

  async intervals(): Promise<UsageInterval[]> {
    const rows = await this.sql<
      { node_id: string; started_at: Date; ended_at: Date | null; hourly_rate: number }[]
    >`select node_id, started_at, ended_at, hourly_rate from controller.usage_intervals`;
    return rows.map((r) => ({
      nodeId: r.node_id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      hourlyRate: Number(r.hourly_rate),
    }));
  }

  async openInterval(nodeId: string, at: Date, hourlyRate: number) {
    await this.sql`
      insert into controller.usage_intervals (id, node_id, started_at, hourly_rate)
      values (${`use_${randomUUID()}`}, ${nodeId}, ${at}, ${hourlyRate})
      on conflict do nothing`;
  }

  async closeInterval(nodeId: string, at: Date) {
    await this.sql`
      update controller.usage_intervals set ended_at = greatest(${at}::timestamptz, started_at)
      where node_id = ${nodeId} and ended_at is null`;
  }

  /** Seeding history: a closed interval in the past. */
  async addInterval(i: UsageInterval) {
    await this.sql`
      insert into controller.usage_intervals (id, node_id, started_at, ended_at, hourly_rate)
      values (${`use_${randomUUID()}`}, ${i.nodeId}, ${i.startedAt}, ${i.endedAt}, ${i.hourlyRate})`;
  }

  async enqueue(req: QueuedRequest) {
    await this.sql`
      insert into controller.queued_requests (id, route_alias, node_id, status, attempts, deadline_at, created_at)
      values (${req.id}, ${req.routeAlias}, ${req.nodeId}, ${req.status}, ${req.attempts},
        ${req.deadlineAt}, ${req.createdAt})`;
  }

  async queued(nodeId?: string) {
    const rows = await this.sql<
      {
        id: string;
        route_alias: string;
        node_id: string;
        status: QueuedRequest['status'];
        attempts: number;
        deadline_at: Date;
        created_at: Date;
      }[]
    >`select * from controller.queued_requests
      where status = 'queued' ${nodeId ? this.sql`and node_id = ${nodeId}` : this.sql``}
      order by created_at`;
    return rows.map((r) => ({
      id: r.id,
      routeAlias: r.route_alias,
      nodeId: r.node_id,
      status: r.status,
      attempts: r.attempts,
      deadlineAt: r.deadline_at,
      createdAt: r.created_at,
    }));
  }

  async settleQueued(nodeId: string, status: 'dispatched' | 'expired' | 'cancelled', before?: Date) {
    await this.sql`
      update controller.queued_requests set status = ${status}
      where node_id = ${nodeId} and status = 'queued'
      ${before ? this.sql`and deadline_at <= ${before}` : this.sql``}`;
  }

  async ping() {
    try {
      await this.sql`select 1`;
      return true;
    } catch {
      return false;
    }
  }
}
