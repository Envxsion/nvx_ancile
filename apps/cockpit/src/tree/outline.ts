/**
 * ------------------------------------------------------------------
 *  Title    |  Big trees, cheaply
 *  Ref      |  ROADMAP G (Branch trees with hundreds of forks)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What a tree with hundreds of forks needs to stay quick:
 *           |  its rows in tree order with their level and place among
 *           |  siblings (one pass, not one scan per node), the window
 *           |  of rows near the screen, and a straight top-to-bottom
 *           |  layout for trees too big to hand to elk in a blink.
 *  How      |  flattenTree walks a children map once. rowWindow is the
 *           |  slice of a fixed-height list a viewport shows, plus an
 *           |  overscan, always holding the selected row so the tree's
 *           |  aria-activedescendant names a row that exists.
 *           |  quickLayout puts each node one level below its parent and
 *           |  each leaf in its own column, a parent centred over its
 *           |  children, children in creation order.
 * ------------------------------------------------------------------
 */

export interface TreeLike {
  id: string;
}

export interface OutlineRow<T> {
  node: T;
  /** 1 for a root (aria-level). */
  level: number;
  /** Place among its siblings, from 1 (aria-posinset), and how many (aria-setsize). */
  pos: number;
  size: number;
  hasChildren: boolean;
}

/** Children by parent, in the order given. */
export function childrenOf<T extends TreeLike>(
  nodes: T[],
  parentOf: (n: T) => string | null,
): Map<string | null, T[]> {
  const ids = new Set(nodes.map((n) => n.id));
  const m = new Map<string | null, T[]>();
  for (const n of nodes) {
    // A parent that is not in the tree makes the node a root.
    const p = parentOf(n);
    const key = p && ids.has(p) ? p : null;
    const list = m.get(key);
    if (list) list.push(n);
    else m.set(key, [n]);
  }
  return m;
}

/** Every node in tree order (depth first), with its level and place among siblings. */
export function flattenTree<T extends TreeLike>(
  nodes: T[],
  parentOf: (n: T) => string | null,
): OutlineRow<T>[] {
  const kids = childrenOf(nodes, parentOf);
  const out: OutlineRow<T>[] = [];
  // An explicit stack: a thousand-deep chain must not overflow the call stack.
  const stack: { list: T[]; i: number; level: number }[] = [{ list: kids.get(null) ?? [], i: 0, level: 1 }];
  const seen = new Set<string>();
  while (stack.length) {
    const top = stack[stack.length - 1] as { list: T[]; i: number; level: number };
    if (top.i >= top.list.length) {
      stack.pop();
      continue;
    }
    const node = top.list[top.i] as T;
    top.i++;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const children = kids.get(node.id) ?? [];
    out.push({ node, level: top.level, pos: top.i, size: top.list.length, hasChildren: children.length > 0 });
    if (children.length) stack.push({ list: children, i: 0, level: top.level + 1 });
  }
  return out;
}

/** The rows a viewport shows (with overscan), always including `keep`. */
export function rowWindow(
  count: number,
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  overscan = 8,
  keep?: number,
): number[] {
  if (count <= 0) return [];
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(count - 1, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  const out: number[] = [];
  if (keep !== undefined && keep >= 0 && keep < first) out.push(keep);
  for (let i = first; i <= last; i++) out.push(i);
  if (keep !== undefined && keep > last && keep < count) out.push(keep);
  return out;
}

/** The scrollTop that brings row `index` into view, or null when it is already in view. */
export function scrollToRow(
  index: number,
  scrollTop: number,
  viewport: number,
  rowHeight: number,
): number | null {
  const top = index * rowHeight;
  if (top < scrollTop) return top;
  if (top + rowHeight > scrollTop + viewport) return Math.max(0, top + rowHeight - viewport);
  return null;
}

/**
 * A layered layout in one pass, for trees too big for elk: each node one
 * level below its parent, leaves side by side, a parent centred over its
 * children.
 */
export function quickLayout<T extends TreeLike>(
  nodes: T[],
  parentOf: (n: T) => string | null,
  size: { w: number; h: number; gapX: number; gapY: number },
): Map<string, { x: number; y: number }> {
  const rows = flattenTree(nodes, parentOf);
  const kids = childrenOf(nodes, parentOf);
  const pos = new Map<string, { x: number; y: number }>();
  const stepX = size.w + size.gapX;
  const stepY = size.h + size.gapY;
  let leaf = 0;
  // Leaves get columns in tree order; parents are placed after their children (reverse order).
  for (const r of rows)
    if (!r.hasChildren) pos.set(r.node.id, { x: leaf++ * stepX, y: (r.level - 1) * stepY });
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i] as OutlineRow<T>;
    if (!r.hasChildren) continue;
    const xs = (kids.get(r.node.id) ?? []).map((c) => pos.get(c.id)?.x ?? 0);
    pos.set(r.node.id, { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (r.level - 1) * stepY });
  }
  return pos;
}
