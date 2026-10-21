/**
 * ------------------------------------------------------------------
 *  Title    |  Where a tour step happens
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Work out the screen a step needs, whether you are on
 *           |  it already, and which notebook, thread or flow to
 *           |  open when the route has a parameter.
 *  How      |  Pure functions over the tour and the lists the app
 *           |  already holds; TourOverlay does the navigating and the
 *           |  waiting.
 * ------------------------------------------------------------------
 */

import type { Tour, TourNeed, TourPlace } from './tours';

/** The place step `i` happens: its own, else the last one set before it, else the tour's start. */
export function placeOf(tour: Tour, i: number): TourPlace | null {
  for (let k = Math.min(i, tour.steps.length - 1); k >= 0; k--) {
    const at = tour.steps[k]?.at;
    if (at) return at;
  }
  return tour.start;
}

/** Is the tour on the screen `place` names? An `exact` address (a settings group) must match as written. */
export function onPlace(place: TourPlace, pathname: string): boolean {
  if (place.exact) return pathname.replace(/\/+$/, '') === place.exact;
  return routeMatches(place.route, pathname);
}

/** Does `pathname` sit on the route pattern (`/n/$notebookId` matches `/n/abc`)? */
export function routeMatches(pattern: string, pathname: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  const a = norm(pattern).split('/');
  const b = norm(pathname).split('/');
  if (a.length !== b.length) return false;
  return a.every((seg, i) => (seg.startsWith('$') ? (b[i] ?? '') !== '' : seg === b[i]));
}

/** The name of a pattern's one parameter, if it has one. */
export function paramOf(pattern: string): string | null {
  const seg = pattern.split('/').find((s) => s.startsWith('$'));
  return seg ? seg.slice(1) : null;
}

export interface PlaceLists {
  notebooks?: readonly { id: string; sources: number; archived?: boolean }[] | undefined;
  threads?: readonly { id: string; notebookId?: string | null }[] | undefined;
  flows?: readonly { id: string; scope?: string; name?: string }[] | undefined;
}

/** Still loading the list this need picks from. */
export function listPending(need: TourNeed, lists: PlaceLists): boolean {
  if (need === 'notebook') return !lists.notebooks;
  if (need === 'thread') return !lists.threads;
  return !lists.flows;
}

/**
 * Pick the one to open: a notebook with sources, a thread in such a
 * notebook (likeliest to have citations), a workspace flow. Null when
 * there is none.
 */
export function pickFor(need: TourNeed, lists: PlaceLists): string | null {
  const notebooks = (lists.notebooks ?? []).filter((n) => !n.archived);
  if (need === 'notebook') return (notebooks.find((n) => n.sources > 0) ?? notebooks[0])?.id ?? null;
  if (need === 'thread') {
    const threads = lists.threads ?? [];
    const grounded = new Set(notebooks.filter((n) => n.sources > 0).map((n) => n.id));
    return (threads.find((t) => t.notebookId && grounded.has(t.notebookId)) ?? threads[0])?.id ?? null;
  }
  const flows = (lists.flows ?? []).filter((f) => !f.name?.startsWith('Block:'));
  return (flows.find((f) => f.scope === 'workspace') ?? flows[0])?.id ?? null;
}

export const NEED_LABEL: Record<TourNeed, string> = {
  notebook: 'a notebook',
  thread: 'a thread',
  flow: 'a flow',
};
