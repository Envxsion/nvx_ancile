/**
 * ------------------------------------------------------------------
 *  Title    |  Chain order
 *  Ref      |  DESIGN.md §7.2, packages/contracts RoutingChain
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The edits Admin → Routing makes to a fallback chain:
 *           |  move a model, add one, take one out.
 *  How      |  Pure functions over model ids that return a new array
 *           |  and never the same one changed, so drag, menu and undo
 *           |  all share one set of rules.
 *  Note     |  A move past either end stays put; adding an id already
 *           |  in the chain changes nothing.
 * ------------------------------------------------------------------
 */

/** Move the id at `from` to `to`, clamped to the chain. */
export function moveTo(chain: readonly string[], from: number, to: number): string[] {
  const next = [...chain];
  if (from < 0 || from >= next.length) return next;
  const at = Math.max(0, Math.min(next.length - 1, to));
  const [id] = next.splice(from, 1);
  if (id !== undefined) next.splice(at, 0, id);
  return next;
}

/** One place up (-1) or down (+1). */
export function moveBy(chain: readonly string[], id: string, step: -1 | 1): string[] {
  const i = chain.indexOf(id);
  return i < 0 ? [...chain] : moveTo(chain, i, i + step);
}

/** Add to the end of the chain, the last model routing tries. */
export function addModel(chain: readonly string[], id: string): string[] {
  return chain.includes(id) ? [...chain] : [...chain, id];
}

export function removeModel(chain: readonly string[], id: string): string[] {
  return chain.filter((x) => x !== id);
}

/** True when two chains name the same models in the same order. */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
