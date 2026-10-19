/**
 * ------------------------------------------------------------------
 *  Title    |  Rail selection and attention
 *  Ref      |  ROADMAP TC3, TC4, RA1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Which threads are selected in the rail, and which
 *           |  threads want your eye. Both are plain data, so a
 *           |  windowed list draws only some rows and nothing is
 *           |  lost: selection lives here, not in the rows.
 *  How      |  `order` is every selectable thread id in the rail's
 *           |  order, drawn or not. A range runs along `order`, so
 *           |  Shift+click across hundreds of undrawn rows selects
 *           |  them all. Attention is three states and one rule:
 *           |  needs you (a run waits on an approval), working (a run
 *           |  is live), unread (an answer you have not opened).
 *  Note     |  The memory inbox (memory/Inbox.tsx) uses the same
 *           |  rules over its cards; nothing here knows what an id is.
 * ------------------------------------------------------------------
 */

import type { ThreadSummary } from '../lib/types';

export interface Selection {
  ids: ReadonlySet<string>;
  /** Where a Shift range starts: the last thread picked on its own. */
  anchor: string | null;
}

export const EMPTY: Selection = { ids: new Set(), anchor: null };

/** The ids from `a` to `b` in `order`, both ends included, whichever comes first. */
export function rangeBetween(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return j >= 0 ? [b] : [];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** Ctrl or Cmd click, or Space: flip one thread and make it the new anchor. */
export function toggle(sel: Selection, id: string): Selection {
  const ids = new Set(sel.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id };
}

/**
 * Shift click, or Shift with an arrow: everything from the anchor to `id`. With nothing selected
 * the anchor is `id` itself. `keep` leaves what was selected before (Ctrl+Shift) rather than
 * replacing it.
 */
export function extendTo(sel: Selection, order: readonly string[], id: string, keep = false): Selection {
  const anchor = sel.anchor && order.includes(sel.anchor) ? sel.anchor : id;
  const run = rangeBetween(order, anchor, id);
  return { ids: new Set([...(keep ? sel.ids : []), ...run]), anchor };
}

/** Ctrl+A in the rail. */
export function selectAll(order: readonly string[]): Selection {
  return { ids: new Set(order), anchor: order[0] ?? null };
}

/** Threads that left the rail (deleted, archived elsewhere) leave the selection too. */
export function prune(sel: Selection, order: readonly string[]): Selection {
  if (sel.ids.size === 0) return sel;
  const live = new Set(order);
  let same = true;
  for (const id of sel.ids) if (!live.has(id)) same = false;
  if (same) return sel;
  return {
    ids: new Set([...sel.ids].filter((id) => live.has(id))),
    anchor: sel.anchor && live.has(sel.anchor) ? sel.anchor : null,
  };
}

/** What a drag carries: the whole selection when the grabbed thread is in it, else just that thread. */
export function dragIds(sel: Selection, grabbed: string, order: readonly string[]): string[] {
  if (!sel.ids.has(grabbed)) return [grabbed];
  return order.filter((id) => sel.ids.has(id));
}

/** Said to screen readers when the selection changes. */
export function selectionSaid(n: number, noun = 'thread'): string {
  return n === 0 ? 'Selection cleared' : `${n} ${n === 1 ? noun : `${noun}s`} selected`;
}

/* ---- Attention (RA1) ------------------------------------------------------- */

export type Attention = 'needs_you' | 'working' | 'unread' | 'none';

/**
 * One state per thread. The thread open on screen is never "unread": you are looking at it.
 * A run waiting on an approval outranks one that is just working.
 */
export function attentionOf(
  t: Pick<ThreadSummary, 'live' | 'waiting' | 'unread' | 'id'>,
  openId?: string,
): Attention {
  if (t.waiting) return 'needs_you';
  if (t.live) return 'working';
  if (t.unread && t.id !== openId) return 'unread';
  return 'none';
}

export const ATTENTION_LABEL: Record<Exclude<Attention, 'none'>, string> = {
  needs_you: 'Needs you',
  working: 'Answering',
  unread: 'New answer, not opened yet',
};

export interface RollUp {
  needs_you: number;
  working: number;
  unread: number;
}

/** How many threads in each state: what a notebook row shows for the threads inside it. */
export function rollUp(threads: readonly ThreadSummary[], openId?: string): RollUp {
  const r: RollUp = { needs_you: 0, working: 0, unread: 0 };
  for (const t of threads) {
    const a = attentionOf(t, openId);
    if (a !== 'none') r[a]++;
  }
  return r;
}

/** The state a roll-up shows: the most pressing one that has any. */
export function topOf(r: RollUp): { state: Exclude<Attention, 'none'>; count: number } | null {
  if (r.needs_you) return { state: 'needs_you', count: r.needs_you };
  if (r.working) return { state: 'working', count: r.working };
  if (r.unread) return { state: 'unread', count: r.unread };
  return null;
}

/** The thread after `currentId` in `needs` (wrapping), or the first when you are elsewhere. */
export function nextNeeding(needs: readonly string[], currentId?: string): string | null {
  if (needs.length === 0) return null;
  const at = currentId ? needs.indexOf(currentId) : -1;
  return needs[(at + 1) % needs.length] ?? null;
}
