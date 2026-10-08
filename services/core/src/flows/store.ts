/**
 * ------------------------------------------------------------------
 *  Title    |  Flow store
 *  Ref      |  DESIGN.md §16.3, §16.6
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keep flows, every saved version of each, the decisions
 *           |  their routers made, and the last run of every node.
 *  How      |  A save writes a new version (optimistic: the version you
 *           |  edited must still be the latest, else flow.conflict).
 *           |  Answers use the published version when one is set,
 *           |  otherwise the latest. One flow is active per place (the
 *           |  workspace, a notebook, a thread); activating one turns
 *           |  the others off in the same transaction.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  type Flow,
  type FlowGraph,
  type FlowScope,
  type FlowSummary,
  type RouteDecisionRecord,
} from '@nvx/contracts';
import type { Sql } from 'postgres';
import { ulid } from 'ulid';
import { pgSafe } from '../db/json';
import { modelsOf } from './graph';

export interface NewFlow {
  name: string;
  description: string;
  scope: FlowScope;
  scope_ref: string | null;
  graph: FlowGraph;
  active: boolean;
}

export interface NodeRun {
  flow_id: string;
  node_id: string;
  payload: unknown;
  output: string;
  meta: Record<string, unknown>;
  at: string;
}

export interface FlowStore {
  list(q: { scope?: FlowScope; ref?: string | null }): Promise<FlowSummary[]>;
  get(id: string): Promise<Flow | undefined>;
  /** The graph answers should use (published version, else the latest). */
  getLive(id: string): Promise<Flow | undefined>;
  getVersion(id: string, version: number): Promise<Flow | undefined>;
  versions(id: string): Promise<{ version: number; at: string; message: string | null; nodes: number }[]>;
  create(f: NewFlow): Promise<Flow>;
  save(
    id: string,
    next: { name: string; description: string; graph: FlowGraph; message?: string | null },
    baseVersion: number,
  ): Promise<Flow>;
  remove(id: string): Promise<boolean>;
  activate(id: string, on: boolean): Promise<Flow>;
  /**
   * Its notebook or thread was deleted: keep the flow as an inactive
   * workspace draft (a flow is work; it is not thrown away with its home).
   * Returns the flows moved.
   */
  orphan(scope: 'notebook' | 'thread', ref: string): Promise<FlowSummary[]>;
  publish(id: string, version: number | null): Promise<Flow>;
  activeFor(scope: FlowScope, ref: string | null): Promise<Flow | undefined>;
  recordDecision(d: Omit<RouteDecisionRecord, 'label' | 'at'>): Promise<void>;
  decisions(q: {
    flowId: string;
    nodeId?: string;
    limit?: number;
    sinceDays?: number;
  }): Promise<RouteDecisionRecord[]>;
  labelDecision(messageId: string, nodeId: string, label: string | null): Promise<boolean>;
  recordNodeRun(r: Omit<NodeRun, 'at'>): Promise<void>;
  lastNodeRun(flowId: string, nodeId: string): Promise<NodeRun | undefined>;
  /** Typical time and cost per node, from the flow's recent answers. */
  nodeStats(flowId: string): Promise<Record<string, NodeStats>>;
}

export interface NodeStats {
  runs: number;
  p50_ms: number;
  p95_ms: number;
  avg_cost_usd: number;
}

interface StepLike {
  node_id: string;
  status: string;
  ms: number;
  cost_usd?: number;
}

const pct = (sorted: number[], p: number) =>
  sorted.length
    ? (sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))] as number)
    : 0;

/** Per node: runs, median and 95th-percentile time, mean cost. Pinned, cached and skipped steps don't count. */
export function statsFromSteps(answers: StepLike[][]): Record<string, NodeStats> {
  const by = new Map<string, { ms: number[]; cost: number }>();
  for (const steps of answers)
    for (const st of steps) {
      if (st.status !== 'done' && st.status !== 'failed') continue;
      const b = by.get(st.node_id) ?? { ms: [], cost: 0 };
      b.ms.push(st.ms);
      b.cost += st.cost_usd ?? 0;
      by.set(st.node_id, b);
    }
  const out: Record<string, NodeStats> = {};
  for (const [id, b] of by) {
    const ms = [...b.ms].sort((x, y) => x - y);
    out[id] = {
      runs: ms.length,
      p50_ms: pct(ms, 0.5),
      p95_ms: pct(ms, 0.95),
      avg_cost_usd: b.cost / ms.length,
    };
  }
  return out;
}

export const flowNotFound = () =>
  new AncileError({
    code: 'flow.not_found',
    title: 'That flow does not exist',
    hint: 'It may have been deleted. Pick another flow, or make a new one.',
    status: 404,
    errorClass: 'permanent',
  });

export const flowConflict = (latest: number) =>
  new AncileError({
    code: 'flow.conflict',
    title: 'This flow changed while you were editing it',
    hint: `Version ${latest} was saved in the meantime. Reload it, then make your change again.`,
    status: 409,
    errorClass: 'permanent',
    context: { latest_version: latest },
  });

const versionMissing = (v: number) =>
  new AncileError({
    code: 'flow.version_missing',
    title: `There is no version ${v} of this flow`,
    hint: 'Pick a version from its history.',
    status: 404,
    errorClass: 'permanent',
  });

export function summaryOf(f: Flow): FlowSummary {
  const runnable = f.nodes.filter((n) => n.kind !== 'note' && n.kind !== 'group');
  return {
    id: f.id,
    name: f.name,
    description: f.description,
    scope: f.scope,
    scope_ref: f.scope_ref,
    version: f.version,
    active: f.active,
    updated_at: f.updated_at,
    nodes: runnable.length,
    models: [...new Set(runnable.flatMap(modelsOf))],
  };
}

const newId = () => `flw_${ulid()}`;
const graphOf = (f: Flow): FlowGraph => ({
  nodes: f.nodes,
  edges: f.edges,
  settings: f.settings,
  ...(f.viewport && { viewport: f.viewport }),
});

/* ---- Postgres ------------------------------------------------------------------ */

interface FlowRow {
  id: string;
  scope: FlowScope;
  scope_ref: string | null;
  name: string;
  description: string;
  graph: FlowGraph;
  version: number;
  active: boolean;
  published_version: number | null;
  created_at: Date;
  updated_at: Date;
}

const fromRow = (r: FlowRow): Flow => ({
  ...r.graph,
  id: r.id,
  name: r.name,
  description: r.description,
  scope: r.scope,
  scope_ref: r.scope_ref,
  version: r.version,
  active: r.active,
  published_version: r.published_version,
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
});

export class PgFlowStore implements FlowStore {
  constructor(
    private readonly sql: Sql,
    private readonly workspaceId: string,
  ) {}

  async list(q: { scope?: FlowScope; ref?: string | null }) {
    const rows = await this.sql<FlowRow[]>`
      select * from core.flows where workspace_id = ${this.workspaceId} and deleted_at is null
        ${q.scope ? this.sql`and scope = ${q.scope}` : this.sql``}
        ${q.ref !== undefined ? (q.ref === null ? this.sql`and scope_ref is null` : this.sql`and scope_ref = ${q.ref}`) : this.sql``}
      order by active desc, updated_at desc`;
    return rows.map((r) => summaryOf(fromRow(r)));
  }

  async get(id: string) {
    const rows = await this.sql<FlowRow[]>`
      select * from core.flows where id = ${id} and workspace_id = ${this.workspaceId} and deleted_at is null`;
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async getLive(id: string) {
    const f = await this.get(id);
    if (!f || f.published_version === null || f.published_version === f.version) return f;
    return this.getVersion(id, f.published_version);
  }

  async getVersion(id: string, version: number) {
    const f = await this.get(id);
    if (!f) return undefined;
    const rows = await this.sql<{ name: string; graph: FlowGraph; created_at: Date }[]>`
      select name, graph, created_at from core.flow_versions where flow_id = ${id} and version = ${version}`;
    const v = rows[0];
    if (!v) return undefined;
    return { ...f, ...v.graph, name: v.name, version, updated_at: v.created_at.toISOString() };
  }

  async versions(id: string) {
    const rows = await this.sql<
      { version: number; created_at: Date; message: string | null; graph: FlowGraph }[]
    >`
      select version, created_at, message, graph from core.flow_versions where flow_id = ${id} order by version desc`;
    return rows.map((r) => ({
      version: r.version,
      at: r.created_at.toISOString(),
      message: r.message,
      nodes: r.graph.nodes.filter((n) => n.kind !== 'note' && n.kind !== 'group').length,
    }));
  }

  async create(f: NewFlow) {
    const id = newId();
    const graph = pgSafe(f.graph);
    await this.sql.begin(async (tx) => {
      if (f.active)
        await tx`update core.flows set active = false where workspace_id = ${this.workspaceId}
          and scope = ${f.scope} and coalesce(scope_ref, '') = ${f.scope_ref ?? ''} and active and deleted_at is null`;
      await tx`insert into core.flows (id, workspace_id, scope, scope_ref, name, description, graph, version, active)
        values (${id}, ${this.workspaceId}, ${f.scope}, ${f.scope_ref}, ${f.name}, ${f.description},
                ${tx.json(graph as never)}, 1, ${f.active})`;
      await tx`insert into core.flow_versions (flow_id, version, name, graph, message)
        values (${id}, 1, ${f.name}, ${tx.json(graph as never)}, 'Created')`;
    });
    return (await this.get(id)) as Flow;
  }

  async save(
    id: string,
    next: { name: string; description: string; graph: FlowGraph; message?: string | null },
    baseVersion: number,
  ) {
    const graph = pgSafe(next.graph);
    const out = await this.sql.begin(async (tx) => {
      const rows = await tx<{ version: number }[]>`
        select version from core.flows where id = ${id} and workspace_id = ${this.workspaceId} and deleted_at is null
        for update`;
      const cur = rows[0];
      if (!cur) throw flowNotFound();
      if (cur.version !== baseVersion) throw flowConflict(cur.version);
      const v = cur.version + 1;
      await tx`update core.flows set name = ${next.name}, description = ${next.description},
        graph = ${tx.json(graph as never)}, version = ${v}, updated_at = now() where id = ${id}`;
      await tx`insert into core.flow_versions (flow_id, version, name, graph, message)
        values (${id}, ${v}, ${next.name}, ${tx.json(graph as never)}, ${next.message ?? null})`;
      return v;
    });
    void out;
    return (await this.get(id)) as Flow;
  }

  async remove(id: string) {
    const r = await this.sql`update core.flows set deleted_at = now(), active = false
      where id = ${id} and workspace_id = ${this.workspaceId} and deleted_at is null`;
    return r.count > 0;
  }

  async activate(id: string, on: boolean) {
    const f = await this.get(id);
    if (!f) throw flowNotFound();
    await this.sql.begin(async (tx) => {
      if (on)
        await tx`update core.flows set active = false where workspace_id = ${this.workspaceId}
          and scope = ${f.scope} and coalesce(scope_ref, '') = ${f.scope_ref ?? ''} and active and id <> ${id}`;
      await tx`update core.flows set active = ${on}, updated_at = now() where id = ${id}`;
    });
    return (await this.get(id)) as Flow;
  }

  async orphan(scope: 'notebook' | 'thread', ref: string) {
    const moved = await this.list({ scope, ref });
    if (moved.length)
      await this
        .sql`update core.flows set scope = 'workspace', scope_ref = null, active = false, updated_at = now()
        where workspace_id = ${this.workspaceId} and scope = ${scope} and scope_ref = ${ref} and deleted_at is null`;
    return moved;
  }

  async publish(id: string, version: number | null) {
    const f = await this.get(id);
    if (!f) throw flowNotFound();
    if (version !== null && !(await this.getVersion(id, version))) throw versionMissing(version);
    await this.sql`update core.flows set published_version = ${version}, updated_at = now() where id = ${id}`;
    return (await this.get(id)) as Flow;
  }

  async activeFor(scope: FlowScope, ref: string | null) {
    const rows = await this.sql<{ id: string }[]>`
      select id from core.flows where workspace_id = ${this.workspaceId} and scope = ${scope}
        and coalesce(scope_ref, '') = ${ref ?? ''} and active and deleted_at is null limit 1`;
    return rows[0] ? this.getLive(rows[0].id) : undefined;
  }

  async recordDecision(d: Omit<RouteDecisionRecord, 'label' | 'at'>) {
    await this.sql`
      insert into core.flow_decisions (message_id, node_id, thread_id, flow_id, version, chose, scores, confidence)
      values (${d.message_id}, ${d.node_id}, ${d.thread_id}, ${d.flow_id}, ${d.version}, ${d.chose},
              ${d.scores ? this.sql.json(d.scores as never) : null}, ${d.confidence})
      on conflict (message_id, node_id) do update set chose = excluded.chose, scores = excluded.scores,
        confidence = excluded.confidence, version = excluded.version, at = now()`;
  }

  async decisions(q: { flowId: string; nodeId?: string; limit?: number; sinceDays?: number }) {
    const rows = await this.sql<
      {
        message_id: string;
        node_id: string;
        thread_id: string;
        flow_id: string;
        version: number;
        chose: string[];
        scores: Record<string, number> | null;
        confidence: number | null;
        label: string | null;
        at: Date;
      }[]
    >`
      select * from core.flow_decisions where flow_id = ${q.flowId}
        ${q.nodeId ? this.sql`and node_id = ${q.nodeId}` : this.sql``}
        ${q.sinceDays ? this.sql`and at > now() - make_interval(days => ${q.sinceDays})` : this.sql``}
      order by at desc limit ${q.limit ?? 200}`;
    return rows.map((r) => ({
      message_id: r.message_id,
      node_id: r.node_id,
      thread_id: r.thread_id,
      flow_id: r.flow_id,
      version: r.version,
      chose: r.chose,
      ...(r.scores && { scores: r.scores }),
      confidence: r.confidence,
      label: r.label,
      at: r.at.toISOString(),
    }));
  }

  async labelDecision(messageId: string, nodeId: string, label: string | null) {
    const r = await this.sql`update core.flow_decisions set label = ${label}
      where message_id = ${messageId} and node_id = ${nodeId}`;
    return r.count > 0;
  }

  async recordNodeRun(r: Omit<NodeRun, 'at'>) {
    await this.sql`
      insert into core.flow_node_runs (flow_id, node_id, payload, output, meta)
      values (${r.flow_id}, ${r.node_id}, ${this.sql.json(pgSafe(r.payload) as never)}, ${r.output},
              ${this.sql.json(pgSafe(r.meta) as never)})
      on conflict (flow_id, node_id) do update set payload = excluded.payload, output = excluded.output,
        meta = excluded.meta, at = now()`;
  }

  async lastNodeRun(flowId: string, nodeId: string) {
    const rows = await this.sql<
      { payload: unknown; output: string; meta: Record<string, unknown>; at: Date }[]
    >`
      select payload, output, meta, at from core.flow_node_runs where flow_id = ${flowId} and node_id = ${nodeId}`;
    const r = rows[0];
    return r
      ? {
          flow_id: flowId,
          node_id: nodeId,
          payload: r.payload,
          output: r.output,
          meta: r.meta,
          at: r.at.toISOString(),
        }
      : undefined;
  }

  async nodeStats(flowId: string) {
    const rows = await this.sql<{ steps: StepLike[] | null }[]>`
      select provenance->'flow'->'steps' as steps from core.messages
      where provenance->'flow'->>'flow_id' = ${flowId} and deleted_at is null
      order by created_at desc limit 300`;
    return statsFromSteps(rows.map((r) => r.steps ?? []));
  }
}

/* ---- In memory (tests) ---------------------------------------------------------- */

export class MemoryFlowStore implements FlowStore {
  flows = new Map<string, Flow & { deleted?: boolean }>();
  history = new Map<string, { version: number; at: string; message: string | null; flow: Flow }[]>();
  decisionRows: RouteDecisionRecord[] = [];
  nodeRuns = new Map<string, NodeRun>();

  private now = () => new Date().toISOString();

  async list(q: { scope?: FlowScope; ref?: string | null }) {
    return [...this.flows.values()]
      .filter((f) => !f.deleted)
      .filter((f) => !q.scope || f.scope === q.scope)
      .filter((f) => q.ref === undefined || f.scope_ref === q.ref)
      .sort((a, b) => Number(b.active) - Number(a.active) || b.updated_at.localeCompare(a.updated_at))
      .map(summaryOf);
  }

  async get(id: string) {
    const f = this.flows.get(id);
    if (!f || f.deleted) return undefined;
    const { deleted: _d, ...rest } = f;
    return structuredClone(rest);
  }

  async getLive(id: string) {
    const f = await this.get(id);
    if (!f || f.published_version === null || f.published_version === f.version) return f;
    return this.getVersion(id, f.published_version);
  }

  async getVersion(id: string, version: number) {
    const f = await this.get(id);
    const v = this.history.get(id)?.find((h) => h.version === version);
    if (!f || !v) return undefined;
    return { ...f, ...graphOf(v.flow), name: v.flow.name, version, updated_at: v.at };
  }

  async versions(id: string) {
    return [...(this.history.get(id) ?? [])].reverse().map((h) => ({
      version: h.version,
      at: h.at,
      message: h.message,
      nodes: h.flow.nodes.filter((n) => n.kind !== 'note' && n.kind !== 'group').length,
    }));
  }

  private deactivateOthers(f: { scope: FlowScope; scope_ref: string | null }, except?: string) {
    for (const o of this.flows.values())
      if (
        o.id !== except &&
        !o.deleted &&
        o.active &&
        o.scope === f.scope &&
        (o.scope_ref ?? '') === (f.scope_ref ?? '')
      )
        o.active = false;
  }

  async create(n: NewFlow) {
    const id = newId();
    if (n.active) this.deactivateOthers(n);
    const at = this.now();
    const f: Flow = {
      ...structuredClone(n.graph),
      id,
      name: n.name,
      description: n.description,
      scope: n.scope,
      scope_ref: n.scope_ref,
      version: 1,
      active: n.active,
      published_version: null,
      created_at: at,
      updated_at: at,
    };
    this.flows.set(id, f);
    this.history.set(id, [{ version: 1, at, message: 'Created', flow: structuredClone(f) }]);
    return structuredClone(f);
  }

  async save(
    id: string,
    next: { name: string; description: string; graph: FlowGraph; message?: string | null },
    baseVersion: number,
  ) {
    const f = this.flows.get(id);
    if (!f || f.deleted) throw flowNotFound();
    if (f.version !== baseVersion) throw flowConflict(f.version);
    const at = this.now();
    Object.assign(f, structuredClone(next.graph), {
      name: next.name,
      description: next.description,
      version: f.version + 1,
      updated_at: at,
    });
    this.history
      .get(id)
      ?.push({ version: f.version, at, message: next.message ?? null, flow: structuredClone(f) });
    return (await this.get(id)) as Flow;
  }

  async remove(id: string) {
    const f = this.flows.get(id);
    if (!f || f.deleted) return false;
    f.deleted = true;
    f.active = false;
    return true;
  }

  async activate(id: string, on: boolean) {
    const f = this.flows.get(id);
    if (!f || f.deleted) throw flowNotFound();
    if (on) this.deactivateOthers(f, id);
    f.active = on;
    f.updated_at = this.now();
    return (await this.get(id)) as Flow;
  }

  async orphan(scope: 'notebook' | 'thread', ref: string) {
    const moved = await this.list({ scope, ref });
    for (const m of moved) {
      const f = this.flows.get(m.id);
      if (!f) continue;
      f.scope = 'workspace';
      f.scope_ref = null;
      f.active = false;
      f.updated_at = this.now();
    }
    return moved;
  }

  async publish(id: string, version: number | null) {
    const f = this.flows.get(id);
    if (!f || f.deleted) throw flowNotFound();
    if (version !== null && !this.history.get(id)?.some((h) => h.version === version))
      throw versionMissing(version);
    f.published_version = version;
    return (await this.get(id)) as Flow;
  }

  async activeFor(scope: FlowScope, ref: string | null) {
    const f = [...this.flows.values()].find(
      (o) => !o.deleted && o.active && o.scope === scope && (o.scope_ref ?? '') === (ref ?? ''),
    );
    return f ? this.getLive(f.id) : undefined;
  }

  async recordDecision(d: Omit<RouteDecisionRecord, 'label' | 'at'>) {
    this.decisionRows = this.decisionRows.filter(
      (r) => !(r.message_id === d.message_id && r.node_id === d.node_id),
    );
    this.decisionRows.push({ ...d, label: null, at: this.now() });
  }

  async decisions(q: { flowId: string; nodeId?: string; limit?: number; sinceDays?: number }) {
    const since = q.sinceDays ? Date.now() - q.sinceDays * 86_400_000 : 0;
    return this.decisionRows
      .filter(
        (r) => r.flow_id === q.flowId && (!q.nodeId || r.node_id === q.nodeId) && Date.parse(r.at) >= since,
      )
      .reverse()
      .slice(0, q.limit ?? 200);
  }

  async labelDecision(messageId: string, nodeId: string, label: string | null) {
    const r = this.decisionRows.find((x) => x.message_id === messageId && x.node_id === nodeId);
    if (!r) return false;
    r.label = label;
    return true;
  }

  async recordNodeRun(r: Omit<NodeRun, 'at'>) {
    this.nodeRuns.set(`${r.flow_id}/${r.node_id}`, { ...structuredClone(r), at: this.now() });
  }

  async lastNodeRun(flowId: string, nodeId: string) {
    return this.nodeRuns.get(`${flowId}/${nodeId}`);
  }

  /** Answers' step lists, by flow id (tests feed these). */
  stepsByFlow = new Map<string, StepLike[][]>();

  async nodeStats(flowId: string) {
    return statsFromSteps(this.stepsByFlow.get(flowId) ?? []);
  }
}
