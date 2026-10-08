/**
 * ------------------------------------------------------------------
 *  Title    |  Controller store
 *  ID       |  controller
 * ------------------------------------------------------------------
 *  Purpose  |  One interface over persistence, so the app, the
 *           |  executor and the contract suite run the same code on
 *           |  Postgres or in memory.
 *  How      |  MemoryStore is complete and used by tests and the
 *           |  contract suite. Every write emits on `events`, which
 *           |  feeds the SSE streams.
 *  Note     |  PgStore (pgstore.ts) is the same interface over the
 *           |  controller schema; it is what runs outside tests.
 * ------------------------------------------------------------------
 */

import { EventEmitter } from 'node:events';
import type { ComputeNode, Operation, Rule } from '@nvx/contracts/controller';
import type { UsageInterval } from './costs/compute';

export interface NodeRecord extends ComputeNode {
  createdAt: Date;
  terminatedAt: Date | null;
  runningSince: Date | null;
}

export interface RouteTarget {
  node_id?: string;
  upstream?: string;
  weight?: number;
  max_queue_s?: number;
}
export interface RouteRecord {
  alias: string;
  targets: RouteTarget[];
  policy: Record<string, unknown>;
}

export interface QueuedRequest {
  id: string;
  routeAlias: string;
  nodeId: string;
  status: 'queued' | 'dispatched' | 'expired' | 'cancelled';
  attempts: number;
  deadlineAt: Date;
  createdAt: Date;
}

export type StoreEvent =
  | { type: 'operation'; op: Operation }
  | { type: 'node'; node: NodeRecord }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; title: string; body: string };

export interface Store {
  readonly events: EventEmitter<{ event: [StoreEvent] }>;
  listNodes(): Promise<NodeRecord[]>;
  getNode(id: string): Promise<NodeRecord | undefined>;
  putNode(node: NodeRecord): Promise<void>;
  /** Stop managing a node (the provider's machine is untouched). */
  deleteNode(id: string): Promise<boolean>;
  getOperation(id: string): Promise<Operation | undefined>;
  findOperationByKey(key: string): Promise<Operation | undefined>;
  liveOperationFor(nodeId: string): Promise<Operation | undefined>;
  putOperation(op: Operation, idempotencyKey?: string): Promise<void>;
  /** Newest first: a node's recent operations, for its card. */
  listOperations(nodeId: string, limit?: number): Promise<Operation[]>;
  listRules(): Promise<Rule[]>;
  putRule(rule: Rule): Promise<void>;
  deleteRule(id: string): Promise<boolean>;
  ruleFiredAt(id: string): Promise<Date | null>;
  markRuleFired(id: string, at: Date): Promise<void>;
  listRoutes(): Promise<RouteRecord[]>;
  putRoute(route: RouteRecord): Promise<void>;
  intervals(): Promise<UsageInterval[]>;
  openInterval(nodeId: string, at: Date, hourlyRate: number): Promise<void>;
  closeInterval(nodeId: string, at: Date): Promise<void>;
  /** A closed interval from the past (seeding sample history). */
  addInterval(interval: UsageInterval): Promise<void>;
  enqueue(req: QueuedRequest): Promise<void>;
  queued(nodeId?: string): Promise<QueuedRequest[]>;
  /** Mark a node's queued requests dispatched (it woke), expired or cancelled. */
  settleQueued(nodeId: string, status: 'dispatched' | 'expired' | 'cancelled', before?: Date): Promise<void>;
  ping(): Promise<boolean>;
}

const LIVE = new Set(['requested', 'acknowledged', 'in_progress']);

export class MemoryStore implements Store {
  readonly events = new EventEmitter<{ event: [StoreEvent] }>();
  private nodes = new Map<string, NodeRecord>();
  private ops = new Map<string, Operation>();
  private keys = new Map<string, string>();
  private rules = new Map<string, Rule>();
  private fired = new Map<string, Date>();
  private routes = new Map<string, RouteRecord>();
  private usage: UsageInterval[] = [];
  private queue: QueuedRequest[] = [];

  constructor() {
    this.events.setMaxListeners(200);
  }

  async listNodes() {
    return [...this.nodes.values()];
  }
  async getNode(id: string) {
    return this.nodes.get(id);
  }
  async putNode(node: NodeRecord) {
    this.nodes.set(node.id, node);
    this.events.emit('event', { type: 'node', node });
  }
  async deleteNode(id: string) {
    const had = this.nodes.delete(id);
    for (const [alias, r] of this.routes)
      if (r.targets.some((t) => t.node_id === id)) this.routes.delete(alias);
    return had;
  }
  async getOperation(id: string) {
    return this.ops.get(id);
  }
  async findOperationByKey(key: string) {
    const id = this.keys.get(key);
    return id ? this.ops.get(id) : undefined;
  }
  async liveOperationFor(nodeId: string) {
    return [...this.ops.values()].find((o) => o.node_id === nodeId && LIVE.has(o.status));
  }
  async putOperation(op: Operation, idempotencyKey?: string) {
    this.ops.set(op.id, op);
    if (idempotencyKey) this.keys.set(idempotencyKey, op.id);
    this.events.emit('event', { type: 'operation', op });
  }
  async listOperations(nodeId: string, limit = 20) {
    return [...this.ops.values()]
      .filter((o) => o.node_id === nodeId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }
  async ruleFiredAt(id: string) {
    return this.fired.get(id) ?? null;
  }
  async markRuleFired(id: string, at: Date) {
    this.fired.set(id, at);
  }
  async addInterval(interval: UsageInterval) {
    this.usage.push({ ...interval });
  }
  async settleQueued(nodeId: string, status: 'dispatched' | 'expired' | 'cancelled', before?: Date) {
    for (const q of this.queue)
      if (q.nodeId === nodeId && q.status === 'queued' && (!before || q.deadlineAt <= before))
        q.status = status;
  }
  async listRules() {
    return [...this.rules.values()];
  }
  async putRule(rule: Rule) {
    this.rules.set(rule.id, rule);
  }
  async deleteRule(id: string) {
    return this.rules.delete(id);
  }
  async listRoutes() {
    return [...this.routes.values()];
  }
  async putRoute(route: RouteRecord) {
    this.routes.set(route.alias, route);
  }
  async intervals() {
    return [...this.usage];
  }
  async openInterval(nodeId: string, at: Date, hourlyRate: number) {
    if (this.usage.some((u) => u.nodeId === nodeId && u.endedAt === null)) return;
    this.usage.push({ nodeId, startedAt: at, endedAt: null, hourlyRate });
  }
  async closeInterval(nodeId: string, at: Date) {
    for (const u of this.usage) if (u.nodeId === nodeId && u.endedAt === null) u.endedAt = at;
  }
  async enqueue(req: QueuedRequest) {
    this.queue.push(req);
  }
  async queued(nodeId?: string) {
    return this.queue.filter((q) => q.status === 'queued' && (!nodeId || q.nodeId === nodeId));
  }
  async ping() {
    return true;
  }
}
