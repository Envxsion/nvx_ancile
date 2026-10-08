/**
 * ------------------------------------------------------------------
 *  Title    |  Paths through the message tree
 *  Ref      |  DESIGN.md §8
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The context for any request is exactly the ancestor
 *           |  path of its parent. Branches share history up to the
 *           |  fork because they literally share those rows; nothing
 *           |  is copied, so nothing drifts.
 *  How      |  Pure functions over {id, parentId} nodes: ancestor path,
 *           |  compaction substitution (a summary keyed by the message
 *           |  it covers up to is valid for every branch through that
 *           |  message), lowest common ancestor for compare, the
 *           |  collapsed tree for the branch view, and branch-point
 *           |  snapping so no path ends on a dangling tool call.
 * ------------------------------------------------------------------
 */

export interface TreeMsg {
  id: string;
  parentId: string | null;
  role?: 'system' | 'user' | 'assistant' | 'tool';
  /** True when this assistant message's parts contain a tool_call. */
  hasToolCall?: boolean;
}

export interface Compaction {
  id: string;
  uptoMessageId: string;
  tokens: number;
}

export class BrokenTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokenTreeError';
  }
}

/** Root → head, inclusive. Throws on a missing parent or a cycle. */
export function ancestorPath<M extends TreeMsg>(byId: ReadonlyMap<string, M>, headId: string): M[] {
  const out: M[] = [];
  const seen = new Set<string>();
  let cur: string | null = headId;
  while (cur !== null) {
    if (seen.has(cur)) throw new BrokenTreeError(`cycle at ${cur}`);
    seen.add(cur);
    const m = byId.get(cur);
    if (!m) throw new BrokenTreeError(`message ${cur} is missing from the tree`);
    out.push(m);
    cur = m.parentId;
  }
  return out.reverse();
}

/**
 * Replace the longest summarised prefix of `path` with its summary, keeping
 * at least `keepRecent` messages verbatim at the end.
 */
export function applyCompaction<M extends TreeMsg, C extends Compaction>(
  path: M[],
  compactions: C[],
  opts: { keepRecent: number },
): { summary: C | null; messages: M[] } {
  const index = new Map(path.map((m, i) => [m.id, i] as const));
  let best: { c: C; i: number } | null = null;
  for (const c of compactions) {
    const i = index.get(c.uptoMessageId);
    if (i === undefined || i >= path.length - opts.keepRecent) continue;
    if (!best || i > best.i) best = { c, i };
  }
  return best ? { summary: best.c, messages: path.slice(best.i + 1) } : { summary: null, messages: path };
}

export function childrenIndex<M extends TreeMsg>(msgs: Iterable<M>): Map<string | null, M[]> {
  const kids = new Map<string | null, M[]>();
  for (const m of msgs) {
    const list = kids.get(m.parentId) ?? [];
    list.push(m);
    kids.set(m.parentId, list);
  }
  return kids;
}

/** For the ‹ 2 / 3 › control. Siblings are ordered by insertion (creation). */
export function siblingInfo<M extends TreeMsg>(
  kids: Map<string | null, M[]>,
  msg: M,
): { index: number; count: number; ids: string[] } {
  const sibs = kids.get(msg.parentId) ?? [msg];
  return { index: sibs.findIndex((s) => s.id === msg.id), count: sibs.length, ids: sibs.map((s) => s.id) };
}

/** The deepest message both paths share, or null if they share nothing. */
export function lowestCommonAncestor<M extends TreeMsg>(
  a: M[],
  b: M[],
): { lca: M | null; aRest: M[]; bRest: M[] } {
  let i = 0;
  while (i < a.length && i < b.length && a[i]?.id === b[i]?.id) i++;
  return { lca: i > 0 ? (a[i - 1] as M) : null, aRest: a.slice(i), bRest: b.slice(i) };
}

/** Follow first children to a leaf: the default head when opening a branch point. */
export function defaultLeaf<M extends TreeMsg>(kids: Map<string | null, M[]>, fromId: string): string {
  let cur = fromId;
  for (;;) {
    const next = kids.get(cur);
    if (!next || next.length === 0) return cur;
    cur = (next.at(-1) as M).id; // newest child: where the user most likely was
  }
}

export interface CollapsedNode {
  id: string;
  parentId: string | null;
  /** Linear messages folded into this node (not counting itself). */
  collapsed: number;
}

/**
 * Fold linear runs: a node is shown when it is a root, a leaf, a fork
 * (≠1 child), or the first message after a fork. Everything else is folded
 * into the nearest shown node above it.
 */
export function collapseLinear<M extends TreeMsg>(msgs: M[]): CollapsedNode[] {
  const kids = childrenIndex(msgs);
  const byId = new Map(msgs.map((m) => [m.id, m] as const));
  const visible = (m: M) => {
    const n = kids.get(m.id)?.length ?? 0;
    if (m.parentId === null || n !== 1) return true;
    return (kids.get(m.parentId)?.length ?? 0) > 1;
  };
  const shown = new Map<string, CollapsedNode>();
  const nearestShown = (id: string | null): string | null => {
    let cur = id;
    while (cur !== null) {
      const m = byId.get(cur);
      if (!m) return null;
      if (visible(m)) return m.id;
      cur = m.parentId;
    }
    return null;
  };
  for (const m of msgs)
    if (visible(m)) shown.set(m.id, { id: m.id, parentId: nearestShown(m.parentId), collapsed: 0 });
  for (const m of msgs) {
    if (visible(m)) continue;
    const owner = nearestShown(m.parentId);
    const node = owner ? shown.get(owner) : undefined;
    if (node) node.collapsed++;
  }
  return [...shown.values()];
}

/**
 * A branch point inside a tool_call → tool_result pair snaps forward to the
 * result, so no branch ever starts from a dangling call (DESIGN.md §8.6).
 */
export function snapBranchPoint<M extends TreeMsg>(kids: Map<string | null, M[]>, msg: M): string {
  if (msg.role === 'assistant' && msg.hasToolCall) {
    const result = kids.get(msg.id)?.find((k) => k.role === 'tool');
    if (result) return result.id;
  }
  return msg.id;
}
