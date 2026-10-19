/**
 * ------------------------------------------------------------------
 *  Title    |  Find in this thread
 *  Ref      |  roadmap TS2
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Find words in the branch on screen, including rows the
 *           |  list has not drawn, thinking, and tool steps that are
 *           |  folded, which the browser's own find cannot see.
 *  How      |  Works on the messages' data, not on the page, so it
 *           |  does not depend on what is mounted. Each match knows
 *           |  its message and where in it the words sit; the thread
 *           |  then jumps to that message and opens that fold. The
 *           |  count is recomputed as an answer streams, and the step
 *           |  you are on stays put while it does.
 *  Note     |  Free searches the current branch. TODO(phase-0.1.1):
 *           |  Pro adds "All branches", listing hits on other branches
 *           |  with a jump that switches branch (Pro seam).
 * ------------------------------------------------------------------
 */

import type { Part } from '@nvx/contracts';
import type { MessageView } from './types';

export type FindWhere = 'text' | 'thinking' | 'tool';

export interface FindHit {
  messageId: string;
  where: FindWhere;
  /** The tool step the words are in, when `where` is 'tool'. */
  callId?: string;
  /** Which match this is within its own place (the answer's text, one thinking block, one step). */
  nth: number;
}

/** Matches past this are counted as "many": a one-letter search should not freeze the page. */
export const FIND_MAX = 2_000;

/** Characters of a tool's input and output that are searched (the view shows no more). */
const TOOL_CHARS = 20_000;

function show(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/** How many times `needle` (lower case) occurs in `hay`, not overlapping. */
export function occurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  const low = hay.toLowerCase();
  let n = 0;
  for (let i = low.indexOf(needle); i !== -1; i = low.indexOf(needle, i + needle.length)) n++;
  return n;
}

function partsOf(m: MessageView): Part[] {
  return m.parts ?? [];
}

/** Every place `query` occurs on the branch, in reading order. */
export function findInThread(messages: MessageView[], query: string): FindHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 1) return [];
  const hits: FindHit[] = [];
  for (const m of messages) {
    if (m.folded) continue;
    const add = (where: FindWhere, count: number, callId?: string) => {
      for (let i = 0; i < count && hits.length < FIND_MAX; i++)
        hits.push({ messageId: m.id, where, nth: i, ...(callId && { callId }) });
    };
    if (m.parts) {
      const results = new Map(
        partsOf(m).flatMap((p) => (p.type === 'tool_result' ? [[p.call_id, p] as const] : [])),
      );
      let text = '';
      for (const p of partsOf(m)) {
        if (p.type === 'text') text += p.text;
        else if (p.type === 'reasoning') add('thinking', occurrences(p.text, needle));
        else if (p.type === 'tool_call') {
          const r = results.get(p.call_id);
          const hay = `${p.tool} ${show(p.args).slice(0, TOOL_CHARS)} ${show(r?.result).slice(0, TOOL_CHARS)}`;
          add('tool', occurrences(hay, needle), p.call_id);
        }
      }
      add('text', occurrences(text, needle));
    } else {
      const text = m.blocks
        .map((b) =>
          b.kind === 'h'
            ? b.text
            : b.kind === 'p'
              ? b.spans.map((s) => s.text).join('')
              : b.items.map((i) => i.map((s) => s.text).join('')).join('\n'),
        )
        .join('\n');
      add('text', occurrences(text, needle));
    }
    if (hits.length >= FIND_MAX) break;
  }
  return hits;
}

/** The next (or previous) match, wrapping at the ends. -1 when there are none. */
export function stepIndex(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/**
 * Keep the match you are on when the list changes under you (a streaming answer adds matches
 * after it): the same message and place if it still exists, else the nearest earlier one.
 */
export function keepActive(prev: FindHit | undefined, hits: FindHit[]): number {
  if (!hits.length) return -1;
  if (!prev) return 0;
  const same = hits.findIndex(
    (h) =>
      h.messageId === prev.messageId &&
      h.where === prev.where &&
      h.callId === prev.callId &&
      h.nth === prev.nth,
  );
  if (same >= 0) return same;
  const inMessage = hits.findIndex((h) => h.messageId === prev.messageId);
  return inMessage >= 0 ? inMessage : 0;
}
