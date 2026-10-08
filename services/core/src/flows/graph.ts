/**
 * ------------------------------------------------------------------
 *  Title    |  Flow graphs
 *  Ref      |  DESIGN.md §16.1, §16.4
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The shape questions every part of Flows asks: which
 *           |  nodes run, what follows what, which edges a manager
 *           |  owns, and whether the graph loops.
 *  How      |  A manager's outgoing edges to working nodes (model,
 *           |  manager, subflow, tool, human) are its *worker* edges:
 *           |  the manager calls those nodes itself, so the scheduler
 *           |  never starts them, and an edge drawn back from a worker
 *           |  to its manager is a return line, not a loop. A Loop node
 *           |  owns its 'body' edge the same way.
 * ------------------------------------------------------------------
 */

import { type FlowEdge, type FlowGraph, type FlowNode, RUNNABLE_KINDS } from '@nvx/contracts';

const WORKER_KINDS = new Set(['model', 'manager', 'subflow', 'tool', 'human']);

export interface Graph {
  nodes: Map<string, FlowNode>;
  out: Map<string, FlowEdge[]>;
  in: Map<string, FlowEdge[]>;
  /** Edges a manager calls itself (manager → worker). */
  workerEdges: Set<string>;
  /** Edges drawn back from a worker to its manager. */
  returnEdges: Set<string>;
  /** Nodes reached only as a manager's workers. */
  workers: Set<string>;
  input: FlowNode | undefined;
  output: FlowNode | undefined;
}

export const isRunnable = (n: FlowNode) => RUNNABLE_KINDS.includes(n.kind);

export function buildGraph(g: Pick<FlowGraph, 'nodes' | 'edges'>): Graph {
  const nodes = new Map(g.nodes.filter(isRunnable).map((n) => [n.id, n] as const));
  const out = new Map<string, FlowEdge[]>();
  const inc = new Map<string, FlowEdge[]>();
  for (const id of nodes.keys()) {
    out.set(id, []);
    inc.set(id, []);
  }
  const workerEdges = new Set<string>();
  for (const e of g.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    out.get(e.from)?.push(e);
    inc.get(e.to)?.push(e);
    const from = nodes.get(e.from) as FlowNode;
    const to = nodes.get(e.to) as FlowNode;
    if (from.kind === 'manager' && WORKER_KINDS.has(to.kind)) workerEdges.add(e.id);
    // A loop runs the node on its 'body' edge itself, again and again.
    if (from.kind === 'loop' && e.label === 'body') workerEdges.add(e.id);
  }
  const returnEdges = new Set<string>();
  for (const e of g.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    const back = (out.get(e.to) ?? []).find((x) => x.to === e.from && workerEdges.has(x.id));
    if (back) returnEdges.add(e.id);
  }
  // A worker is reached only through worker edges.
  const workers = new Set<string>();
  for (const [id, edges] of inc) {
    const live = edges.filter((e) => !returnEdges.has(e.id));
    if (live.length && live.every((e) => workerEdges.has(e.id))) workers.add(id);
  }
  return {
    nodes,
    out,
    in: inc,
    workerEdges,
    returnEdges,
    workers,
    input: [...nodes.values()].find((n) => n.kind === 'input'),
    output: [...nodes.values()].find((n) => n.kind === 'output'),
  };
}

/** Edges the scheduler follows (not worker calls, not return lines). */
export function flowEdges(g: Graph, nodeId: string): FlowEdge[] {
  return (g.out.get(nodeId) ?? []).filter((e) => !g.workerEdges.has(e.id) && !g.returnEdges.has(e.id));
}

export function incomingFlowEdges(g: Graph, nodeId: string): FlowEdge[] {
  return (g.in.get(nodeId) ?? []).filter((e) => !g.workerEdges.has(e.id) && !g.returnEdges.has(e.id));
}

/** A cycle among the edges the scheduler follows, as node ids; null when there is none. */
export function findCycle(g: Graph): string[] | null {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const e of [...flowEdges(g, id), ...(g.out.get(id) ?? []).filter((x) => g.workerEdges.has(x.id))]) {
      const s = state.get(e.to) ?? 0;
      if (s === 1) return [...stack.slice(stack.indexOf(e.to)), e.to];
      if (s === 0) {
        const c = visit(e.to);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of g.nodes.keys()) {
    if ((state.get(id) ?? 0) === 0) {
      const c = visit(id);
      if (c) return c;
    }
  }
  return null;
}

/** Every node reachable from `start` (worker calls included). */
export function reachable(g: Graph, start: string): Set<string> {
  const seen = new Set<string>([start]);
  const todo = [start];
  while (todo.length) {
    const id = todo.pop() as string;
    for (const e of g.out.get(id) ?? []) {
      if (g.returnEdges.has(e.id) || seen.has(e.to)) continue;
      seen.add(e.to);
      todo.push(e.to);
    }
  }
  return seen;
}

/** Nodes that can reach `end` (worker calls count: a worker feeds its manager). */
export function canReach(g: Graph, end: string): Set<string> {
  const seen = new Set<string>([end]);
  const todo = [end];
  while (todo.length) {
    const id = todo.pop() as string;
    for (const e of g.in.get(id) ?? []) {
      if (g.returnEdges.has(e.id) || seen.has(e.from)) continue;
      seen.add(e.from);
      todo.push(e.from);
    }
  }
  for (const w of g.workers) {
    const managers = (g.in.get(w) ?? []).filter((e) => g.workerEdges.has(e.id)).map((e) => e.from);
    if (managers.some((m) => seen.has(m))) seen.add(w);
  }
  return seen;
}

/** Simple paths from input to output along scheduler edges, at most `limit`. */
export function paths(g: Graph, limit = 50): string[][] {
  if (!g.input || !g.output) return [];
  const out: string[][] = [];
  const end = g.output.id;
  const walk = (id: string, path: string[]) => {
    if (out.length >= limit) return;
    if (id === end) {
      out.push(path);
      return;
    }
    for (const e of flowEdges(g, id)) if (!path.includes(e.to)) walk(e.to, [...path, e.to]);
  };
  walk(g.input.id, [g.input.id]);
  return out;
}

/** The model ids a node calls (a manager's own model; its workers count separately). */
export function modelsOf(n: FlowNode): string[] {
  switch (n.kind) {
    case 'model':
    case 'manager':
      return [n.params.model, ...n.params.fallbacks];
    case 'router':
      return [n.params.model];
    case 'join':
      return n.params.mode === 'judge' && n.params.judge_model ? [n.params.judge_model] : [];
    case 'loop':
      return n.params.until_model ? [n.params.until_model] : [];
    case 'factcheck':
      return n.params.verifier ? [n.params.verifier] : [];
    default:
      return [];
  }
}
