/**
 * ------------------------------------------------------------------
 *  Title    |  Flow graph operations
 *  Ref      |  DESIGN.md §16.6
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Everything the editor does to a flow, as pure functions
 *           |  from one graph to the next: add, remove, connect,
 *           |  duplicate, copy and paste, group, align, collapse into
 *           |  a subflow, compare two versions. Undo is a stack of
 *           |  graphs, so every edit is one step back.
 *  How      |  Graphs are never mutated; each op returns a new one.
 *           |  Ids are readable ("router_2") and never reused within
 *           |  a graph, so edges and recorded runs stay unambiguous.
 * ------------------------------------------------------------------
 */

import type { FlowEdge, FlowGraph, FlowNode, FlowNodeKind } from '@nvx/contracts';

export const NODE_W = 248;
export const NODE_H = 104;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function sizeOf(n: FlowNode): { w: number; h: number } {
  if ((n.kind === 'note' || n.kind === 'group') && n.size) return n.size;
  return { w: NODE_W, h: NODE_H };
}

export function boundsOf(nodes: FlowNode[]): Box | null {
  if (!nodes.length) return null;
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = Number.NEGATIVE_INFINITY;
  let y2 = Number.NEGATIVE_INFINITY;
  for (const n of nodes) {
    const s = sizeOf(n);
    x1 = Math.min(x1, n.position.x);
    y1 = Math.min(y1, n.position.y);
    x2 = Math.max(x2, n.position.x + s.w);
    y2 = Math.max(y2, n.position.y + s.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** The next free id for a kind: "model_3". */
export function nextId(
  g: Pick<FlowGraph, 'nodes'>,
  kind: FlowNodeKind | string,
  taken: Set<string> = new Set(),
): string {
  const used = new Set([...g.nodes.map((n) => n.id), ...taken]);
  for (let i = 1; ; i++) {
    const id = `${kind}_${i}`;
    if (!used.has(id)) return id;
  }
}

export function nextEdgeId(g: Pick<FlowGraph, 'edges'>, taken: Set<string> = new Set()): string {
  const used = new Set([...g.edges.map((e) => e.id), ...taken]);
  for (let i = 1; ; i++) {
    const id = `e${i}`;
    if (!used.has(id)) return id;
  }
}

export const emptyGraph = (): FlowGraph => ({
  nodes: [],
  edges: [],
  settings: { max_steps: 24, cost_cap_usd: 1, timeout_s: 600, show_teamwork: 'collapsed' },
});

/* ---- Nodes ------------------------------------------------------------------ */

export function addNode(g: FlowGraph, n: FlowNode): FlowGraph {
  return { ...g, nodes: [...g.nodes, n] };
}

export function updateNode(g: FlowGraph, id: string, patch: Partial<FlowNode>): FlowGraph {
  return {
    ...g,
    nodes: g.nodes.map((n) => (n.id === id ? ({ ...n, ...patch, kind: n.kind } as FlowNode) : n)),
  };
}

export function updateParams(g: FlowGraph, id: string, params: Record<string, unknown>): FlowGraph {
  return {
    ...g,
    nodes: g.nodes.map((n) => (n.id === id ? ({ ...n, params: { ...n.params, ...params } } as FlowNode) : n)),
  };
}

/** Rename a node's id everywhere it is referenced. */
export function renameNode(g: FlowGraph, from: string, to: string): FlowGraph {
  if (from === to || g.nodes.some((n) => n.id === to)) return g;
  return {
    ...g,
    nodes: g.nodes.map((n) => ({
      ...n,
      id: n.id === from ? to : n.id,
      ...(n.parent === from && { parent: to }),
    })),
    edges: g.edges.map((e) => ({ ...e, from: e.from === from ? to : e.from, to: e.to === from ? to : e.to })),
  };
}

export function moveNodes(g: FlowGraph, to: Record<string, { x: number; y: number }>): FlowGraph {
  return {
    ...g,
    nodes: g.nodes.map((n) => (to[n.id] ? { ...n, position: to[n.id] as { x: number; y: number } } : n)),
  };
}

export function removeNodes(g: FlowGraph, ids: Iterable<string>): FlowGraph {
  const gone = new Set(ids);
  return {
    ...g,
    nodes: g.nodes
      .filter((n) => !gone.has(n.id))
      .map((n) => (n.parent && gone.has(n.parent) ? { ...n, parent: undefined } : n)),
    edges: g.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
  };
}

export function setDisabled(g: FlowGraph, ids: string[], disabled: boolean): FlowGraph {
  const s = new Set(ids);
  return { ...g, nodes: g.nodes.map((n) => (s.has(n.id) ? { ...n, disabled: disabled || undefined } : n)) };
}

/* ---- Edges ------------------------------------------------------------------ */

export function canConnect(g: FlowGraph, from: string, to: string, label?: string): boolean {
  if (from === to) return false;
  const a = g.nodes.find((n) => n.id === from);
  const b = g.nodes.find((n) => n.id === to);
  if (!a || !b) return false;
  if (a.kind === 'output' || a.kind === 'note' || a.kind === 'group') return false;
  if (b.kind === 'input' || b.kind === 'note' || b.kind === 'group') return false;
  return !g.edges.some((e) => e.from === from && e.to === to && (e.label ?? '') === (label ?? ''));
}

export function connect(g: FlowGraph, from: string, to: string, label?: string): FlowGraph {
  if (!canConnect(g, from, to, label)) return g;
  // 'out' and a manager's 'answer' are the unlabelled default port.
  const edge: FlowEdge = {
    id: nextEdgeId(g),
    from,
    to,
    ...(label && label !== 'out' && label !== 'answer' && { label }),
  };
  return { ...g, edges: [...g.edges, edge] };
}

export function updateEdge(g: FlowGraph, id: string, patch: Partial<FlowEdge>): FlowGraph {
  return { ...g, edges: g.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)) };
}

export function removeEdges(g: FlowGraph, ids: Iterable<string>): FlowGraph {
  const gone = new Set(ids);
  return { ...g, edges: g.edges.filter((e) => !gone.has(e.id)) };
}

/** A route label renamed on a router: its edges follow. */
export function renameRoute(g: FlowGraph, nodeId: string, from: string, to: string): FlowGraph {
  return {
    ...g,
    edges: g.edges.map((e) => (e.from === nodeId && e.label === from ? { ...e, label: to } : e)),
  };
}

/* ---- Clipboard ------------------------------------------------------------- */

export interface Clip {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/** The selected nodes and the edges between them. */
export function copy(g: FlowGraph, ids: Iterable<string>): Clip {
  const s = new Set(ids);
  // A group brings its children.
  for (const n of g.nodes) if (n.parent && s.has(n.parent)) s.add(n.id);
  return {
    nodes: g.nodes.filter((n) => s.has(n.id)),
    edges: g.edges.filter((e) => s.has(e.from) && s.has(e.to)),
  };
}

/** Paste a clip with fresh ids, offset (or centred on `at`). Returns the new ids. */
export function paste(
  g: FlowGraph,
  clip: Clip,
  at?: { x: number; y: number },
): { graph: FlowGraph; ids: string[] } {
  if (!clip.nodes.length) return { graph: g, ids: [] };
  const box = boundsOf(clip.nodes) as Box;
  const dx = at ? at.x - box.x : 40;
  const dy = at ? at.y - box.y : 40;
  const map = new Map<string, string>();
  const taken = new Set<string>();
  for (const n of clip.nodes) {
    const id = nextId(g, n.kind, taken);
    taken.add(id);
    map.set(n.id, id);
  }
  const nodes = clip.nodes.map(
    (n) =>
      ({
        ...n,
        id: map.get(n.id),
        position: { x: Math.round(n.position.x + dx), y: Math.round(n.position.y + dy) },
        parent: n.parent ? map.get(n.parent) : undefined,
      }) as FlowNode,
  );
  const etaken = new Set<string>();
  const edges = clip.edges.map((e) => {
    const id = nextEdgeId(g, etaken);
    etaken.add(id);
    return { ...e, id, from: map.get(e.from) as string, to: map.get(e.to) as string };
  });
  return {
    graph: { ...g, nodes: [...g.nodes, ...nodes], edges: [...g.edges, ...edges] },
    ids: [...map.values()],
  };
}

export function duplicate(g: FlowGraph, ids: string[]): { graph: FlowGraph; ids: string[] } {
  return paste(g, copy(g, ids));
}

/* ---- Groups ----------------------------------------------------------------- */

const PAD = 36;

export function group(g: FlowGraph, ids: string[], label = 'Group'): { graph: FlowGraph; id: string | null } {
  const members = g.nodes.filter((n) => ids.includes(n.id) && n.kind !== 'group');
  const box = boundsOf(members);
  if (!box) return { graph: g, id: null };
  const id = nextId(g, 'group');
  const frame: FlowNode = {
    id,
    kind: 'group',
    label,
    position: { x: box.x - PAD, y: box.y - PAD - 20 },
    size: { w: box.w + PAD * 2, h: box.h + PAD * 2 + 20 },
    params: { collapsed: false },
  };
  const set = new Set(members.map((m) => m.id));
  return {
    graph: {
      ...g,
      // Groups render first so they sit behind their members.
      nodes: [frame, ...g.nodes.map((n) => (set.has(n.id) ? { ...n, parent: id } : n))],
    },
    id,
  };
}

export function ungroup(g: FlowGraph, groupId: string): FlowGraph {
  return {
    ...g,
    nodes: g.nodes
      .filter((n) => n.id !== groupId)
      .map((n) => (n.parent === groupId ? { ...n, parent: undefined } : n)),
  };
}

/** Members of a group follow it when it moves. */
export function membersOf(g: FlowGraph, groupId: string): FlowNode[] {
  return g.nodes.filter((n) => n.parent === groupId);
}

/* ---- Align and distribute ------------------------------------------------- */

export type Align = 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter';

export function align(g: FlowGraph, ids: string[], how: Align): FlowGraph {
  const sel = g.nodes.filter((n) => ids.includes(n.id));
  const box = boundsOf(sel);
  if (!box || sel.length < 2) return g;
  const to: Record<string, { x: number; y: number }> = {};
  for (const n of sel) {
    const s = sizeOf(n);
    const p = { ...n.position };
    if (how === 'left') p.x = box.x;
    if (how === 'right') p.x = box.x + box.w - s.w;
    if (how === 'top') p.y = box.y;
    if (how === 'bottom') p.y = box.y + box.h - s.h;
    if (how === 'hcenter') p.x = Math.round(box.x + box.w / 2 - s.w / 2);
    if (how === 'vcenter') p.y = Math.round(box.y + box.h / 2 - s.h / 2);
    to[n.id] = p;
  }
  return moveNodes(g, to);
}

export function distribute(g: FlowGraph, ids: string[], axis: 'h' | 'v'): FlowGraph {
  const sel = g.nodes
    .filter((n) => ids.includes(n.id))
    .sort((a, b) => (axis === 'h' ? a.position.x - b.position.x : a.position.y - b.position.y));
  if (sel.length < 3) return g;
  const first = sel[0] as FlowNode;
  const last = sel[sel.length - 1] as FlowNode;
  const start = axis === 'h' ? first.position.x : first.position.y;
  const end = axis === 'h' ? last.position.x : last.position.y;
  const step = (end - start) / (sel.length - 1);
  const to: Record<string, { x: number; y: number }> = {};
  sel.forEach((n, i) => {
    to[n.id] =
      axis === 'h'
        ? { x: Math.round(start + step * i), y: n.position.y }
        : { x: n.position.x, y: Math.round(start + step * i) };
  });
  return moveNodes(g, to);
}

/** Snap a point to the canvas grid. */
export const snap = (v: number, grid = 16) => Math.round(v / grid) * grid;

/* ---- Collapse into a subflow --------------------------------------------- */

/**
 * Take a selection out into its own graph (with its own input and output)
 * and leave one Subflow node in its place. Edges into the selection now
 * enter the subflow; edges out of it leave from the subflow.
 */
export function collapseToSubflow(
  g: FlowGraph,
  ids: string[],
  subflowRef: string,
): { outer: FlowGraph; inner: FlowGraph; nodeId: string } | null {
  const set = new Set(
    g.nodes.filter((n) => ids.includes(n.id) && n.kind !== 'input' && n.kind !== 'output').map((n) => n.id),
  );
  if (!set.size) return null;
  const members = g.nodes.filter((n) => set.has(n.id));
  const box = boundsOf(members) as Box;
  const incoming = g.edges.filter((e) => !set.has(e.from) && set.has(e.to));
  const outgoing = g.edges.filter((e) => set.has(e.from) && !set.has(e.to));
  const internal = g.edges.filter((e) => set.has(e.from) && set.has(e.to));

  // Inner graph: the members, shifted right of a fresh input, with an output.
  const inner: FlowGraph = {
    ...emptyGraph(),
    nodes: [
      { id: 'input', kind: 'input', position: { x: 0, y: box.h / 2 }, params: {} },
      ...members.map((n) => ({
        ...n,
        parent: n.parent && set.has(n.parent) ? n.parent : undefined,
        position: { x: n.position.x - box.x + NODE_W + 80, y: n.position.y - box.y },
      })),
      {
        id: 'output',
        kind: 'output',
        position: { x: box.w + NODE_W * 2 + 160, y: box.h / 2 },
        params: { template: '' },
      },
    ],
    edges: [],
  };
  const etaken = new Set<string>();
  const addInner = (from: string, to: string, label?: string) => {
    if (inner.edges.some((e) => e.from === from && e.to === to && e.label === label)) return;
    const id = nextEdgeId(inner, etaken);
    etaken.add(id);
    inner.edges.push({ id, from, to, ...(label && { label }) });
  };
  for (const e of internal) addInner(e.from, e.to, e.label);
  for (const e of incoming) addInner('input', e.to);
  for (const e of outgoing) addInner(e.from, 'output', e.label);
  if (!incoming.length)
    for (const n of members.filter((m) => !internal.some((e) => e.to === m.id))) addInner('input', n.id);
  if (!outgoing.length)
    for (const n of members.filter((m) => !internal.some((e) => e.from === m.id))) addInner(n.id, 'output');

  // Outer graph: members out, one subflow node in, edges rewired.
  const nodeId = nextId(g, 'subflow');
  const sub: FlowNode = {
    id: nodeId,
    kind: 'subflow',
    label: 'Team',
    position: { x: box.x + box.w / 2 - NODE_W / 2, y: box.y + box.h / 2 - NODE_H / 2 },
    params: { flow_id: subflowRef },
  };
  let outer = removeNodes(g, set);
  outer = { ...outer, nodes: [...outer.nodes, sub] };
  for (const from of new Set(incoming.map((e) => e.from))) {
    const label = incoming.find((e) => e.from === from)?.label;
    outer = connect(outer, from, nodeId, label);
  }
  for (const to of new Set(outgoing.map((e) => e.to))) outer = connect(outer, nodeId, to);
  return { outer, inner, nodeId };
}

/* ---- Diff -------------------------------------------------------------------- */

export interface GraphDiff {
  added: string[];
  removed: string[];
  changed: string[];
  edgesAdded: string[];
  edgesRemoved: string[];
}

const edgeKey = (e: FlowEdge) => `${e.from}>${e.to}:${e.label ?? ''}`;
const comparable = (n: FlowNode) => JSON.stringify({ ...n, position: undefined });

/** What changed from `a` (older) to `b` (newer). Moving a node is not a change. */
export function diff(a: FlowGraph, b: FlowGraph): GraphDiff {
  const am = new Map(a.nodes.map((n) => [n.id, n]));
  const bm = new Map(b.nodes.map((n) => [n.id, n]));
  const ak = new Set(a.edges.map(edgeKey));
  const bk = new Set(b.edges.map(edgeKey));
  return {
    added: b.nodes.filter((n) => !am.has(n.id)).map((n) => n.id),
    removed: a.nodes.filter((n) => !bm.has(n.id)).map((n) => n.id),
    changed: b.nodes
      .filter((n) => {
        const o = am.get(n.id);
        return o && comparable(o) !== comparable(n);
      })
      .map((n) => n.id),
    edgesAdded: b.edges.filter((e) => !ak.has(edgeKey(e))).map(edgeKey),
    edgesRemoved: a.edges.filter((e) => !bk.has(edgeKey(e))).map(edgeKey),
  };
}

/* ---- Paths (for estimates and the live overlay) ------------------------ */

/** Every node reachable from the input, in breadth-first order. */
export function reachable(g: FlowGraph): Set<string> {
  const start = g.nodes.find((n) => n.kind === 'input');
  const seen = new Set<string>();
  if (!start) return seen;
  const queue = [start.id];
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of g.edges) if (e.from === id) queue.push(e.to);
  }
  return seen;
}

/* ---- Undo history --------------------------------------------------------- */

export interface History {
  past: FlowGraph[];
  future: FlowGraph[];
}

export const LIMIT = 200;

export function record(h: History, before: FlowGraph): History {
  return { past: [...h.past.slice(-(LIMIT - 1)), before], future: [] };
}

export function undo(h: History, current: FlowGraph): { history: History; graph: FlowGraph } | null {
  const prev = h.past[h.past.length - 1];
  if (!prev) return null;
  return { history: { past: h.past.slice(0, -1), future: [current, ...h.future] }, graph: prev };
}

export function redo(h: History, current: FlowGraph): { history: History; graph: FlowGraph } | null {
  const next = h.future[0];
  if (!next) return null;
  return { history: { past: [...h.past, current], future: h.future.slice(1) }, graph: next };
}
