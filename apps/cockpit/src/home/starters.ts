/**
 * ------------------------------------------------------------------
 *  Title    |  Starters on the start screen
 *  Ref      |  ROADMAP HM1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  At most three things worth starting with, taken from
 *           |  the current notebook: one of its open tasks, and the
 *           |  sources added most recently. Never a generic prompt.
 *  How      |  Pure. An open task is an unchecked box ("- [ ] text")
 *           |  in a note, newest note first. A source counts once it
 *           |  is ready. Presentation mode, an empty notebook and no
 *           |  notebook at all each give an empty list.
 *  Note     |  Clicking a starter puts its text in the composer; it
 *           |  never sends. Titles can be private, which is why
 *           |  presentation mode switches the whole list off.
 * ------------------------------------------------------------------
 */

import type { Note } from '@nvx/contracts';
import type { SourceView } from '../lib/types';

export interface Starter {
  id: string;
  /** What the card says it is: "Open task" or "New source". */
  label: string;
  /** The task or the source's title, trimmed. */
  title: string;
  /** What goes in the composer. */
  text: string;
}

export const MAX_STARTERS = 3;

const TASK = /^\s*[-*+]\s+\[ \]\s+(.+?)\s*$/;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The unchecked tasks in notes, newest note first, in the order written. */
export function openTasks(
  notes: Pick<Note, 'id' | 'content_md' | 'updated_at'>[],
): { id: string; task: string }[] {
  const out: { id: string; task: string }[] = [];
  const byNewest = [...notes].sort((a, b) =>
    a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0,
  );
  for (const n of byNewest) {
    n.content_md.split(/\r?\n/).forEach((line, i) => {
      const m = TASK.exec(line);
      if (m?.[1]) out.push({ id: `${n.id}:${i}`, task: m[1] });
    });
  }
  return out;
}

export function startersFor(input: {
  notebookId: string | null;
  notes: Pick<Note, 'id' | 'content_md' | 'updated_at'>[];
  sources: Pick<SourceView, 'id' | 'title' | 'status' | 'createdAt'>[];
  /** Presentation mode: nothing from the notebook is shown. */
  presenting: boolean;
}): Starter[] {
  if (input.presenting || !input.notebookId) return [];
  const tasks = openTasks(input.notes).slice(0, 1);
  const recent = input.sources
    .filter((s) => s.status === 'ready' && s.title.trim())
    .sort((a, b) =>
      (a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : (a.createdAt ?? '') > (b.createdAt ?? '') ? -1 : 0,
    )
    .slice(0, MAX_STARTERS - tasks.length);
  return [
    ...tasks.map(
      (t): Starter => ({
        id: `task:${t.id}`,
        label: 'Open task',
        title: clip(t.task, 80),
        text: `Help me with this open task: ${t.task}`,
      }),
    ),
    ...recent.map(
      (s): Starter => ({
        id: `source:${s.id}`,
        label: 'New source',
        title: clip(s.title, 80),
        text: `Summarise "${s.title}" and tell me what is worth acting on.`,
      }),
    ),
  ].slice(0, MAX_STARTERS);
}
