/**
 * ------------------------------------------------------------------
 *  Title    |  Paging a path
 *  Ref      |  docs/api.md (GET /threads/:id/path) · DESIGN.md §8
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A thread imported from Claude Code can hold twenty
 *           |  thousand messages on one path. The Cockpit asks for the
 *           |  head end first and earlier pages as you scroll up, so
 *           |  nothing reads or sends the whole history to show its
 *           |  last screen.
 *  How      |  Pure. The path is worked out from the thread's shape
 *           |  (ids and parents only); this picks the slice [start,
 *           |  end) of it. A page never starts on a message that only
 *           |  carries tool results: those are drawn inside the answer
 *           |  before them, so the page reaches back to that answer.
 * ------------------------------------------------------------------
 */

import type { Part } from '@nvx/contracts';

export interface PageAsk {
  limit?: number | undefined;
  /** End the page just before this message. */
  before?: string | undefined;
  /** Start early enough that this message is in the page. */
  include?: string | undefined;
}

export interface PageRange {
  start: number;
  end: number;
}

/** Thrown when `before` or `include` is not on the path. */
export class NotOnPathError extends Error {
  constructor(readonly field: 'before' | 'include') {
    super(`${field}: that message is not on this path`);
    this.name = 'NotOnPathError';
  }
}

/** Which part of a path of `ids` to send. Without a limit: all of it. */
export function pageRange(ids: readonly string[], ask: PageAsk): PageRange {
  let end = ids.length;
  if (ask.before) {
    const i = ids.indexOf(ask.before);
    if (i < 0) throw new NotOnPathError('before');
    end = i;
  }
  let start = ask.limit === undefined ? 0 : Math.max(0, end - ask.limit);
  if (ask.include) {
    const i = ids.indexOf(ask.include);
    if (i < 0) throw new NotOnPathError('include');
    // A few messages of lead-in above the one asked for.
    if (i < start) start = Math.max(0, i - 4);
    if (i >= end) end = Math.min(ids.length, i + 1);
  }
  return { start, end };
}

/** A message that only carries tool results (Claude Code writes them as user turns). */
export function resultOnly(m: { role: string; parts: Part[] }): boolean {
  if (m.role === 'tool') return true;
  return m.role === 'user' && m.parts.length > 0 && m.parts.every((p) => p.type === 'tool_result');
}

/**
 * Move `start` back past messages that only carry results, so each result
 * arrives with the answer that asked for it. `rows[i]` is path[from + i].
 */
export function snapStart(
  start: number,
  from: number,
  rows: readonly { role: string; parts: Part[] }[],
): { start: number; short: boolean } {
  let s = start;
  for (;;) {
    // Not read yet: the caller reads further back and asks again.
    if (s < from) return { start: s, short: true };
    const row = rows[s - from];
    if (s === 0 || !row || !resultOnly(row)) return { start: s, short: false };
    s--;
  }
}
