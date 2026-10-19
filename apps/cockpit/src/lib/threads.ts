/**
 * ------------------------------------------------------------------
 *  Title    |  Thread actions
 *  Ref      |  ROADMAP TC3, TC4 · guard rail GR23
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Rename, pin, archive, move and delete, from the rail,
 *           |  the palette or the thread itself, one thread or many,
 *           |  each instant and each undoable.
 *  How      |  Optimistic: the cached list changes first, Core second,
 *           |  and a failure rolls the cache back with a toast. Moves,
 *           |  archives and deletes all go through Core's bulk call,
 *           |  which answers with the state every thread had before:
 *           |  Undo sends those states back, so notebook, pin and
 *           |  place in the list return exactly. A delete is a move to
 *           |  the Trash (kept 30 days), so its Undo is real too.
 *  Note     |  One bulk action makes one toast, ten seconds long, that
 *           |  names the count and anything left alone (a thread being
 *           |  answered is never changed). Press U to undo it.
 * ------------------------------------------------------------------
 */

import type { BulkSkip, ThreadBulkRequest, ThreadBulkResult, ThreadState } from '@nvx/contracts';
import { TRASH_DAYS } from '@nvx/contracts/bulk';
import type { InfiniteData } from '@tanstack/react-query';
import { notify } from '../state/notify';
import { ApiCallError, api } from './api';
import { keys } from './data';
import { openExport } from './exportStore';
import { modelName } from './format';
import { partsText } from './mappers';
import { queryClient } from './query';
import type { ThreadSummary, ThreadView } from './types';

interface Page {
  items: ThreadSummary[];
  next: string | null;
}
type List = InfiniteData<Page, string | null>;

/** Guard rail GR23: a move, an archive or a delete can be undone for ten seconds. */
export const UNDO_MS = 10_000;

function snapshot(): List | undefined {
  return queryClient.getQueryData<List>(keys.threads);
}

function mapList(fn: (items: ThreadSummary[]) => ThreadSummary[]): void {
  queryClient.setQueryData<List>(keys.threads, (d) =>
    d ? { ...d, pages: d.pages.map((p) => ({ ...p, items: fn(p.items) })) } : d,
  );
}

function patchLocal(id: string, patch: Partial<ThreadSummary>): void {
  mapList((items) => items.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  queryClient.setQueryData<ThreadView>(keys.thread(id), (t) =>
    t ? { ...t, ...(patch.title !== undefined && { title: patch.title }) } : t,
  );
}

function fail(error: unknown, what: string, before: List | undefined): void {
  queryClient.setQueryData(keys.threads, before);
  notify({
    level: 'error',
    title: error instanceof ApiCallError ? error.body.error.title : `${what} didn't reach Core`,
    body:
      error instanceof ApiCallError
        ? error.body.error.hint
        : 'Nothing changed. Check that NVX Ancile is running, then try again.',
  });
}

async function patch(id: string, body: Record<string, unknown>, local: Partial<ThreadSummary>, what: string) {
  const before = snapshot();
  patchLocal(id, local);
  try {
    await api.patch(`/threads/${id}`, body);
    return true;
  } catch (error) {
    fail(error, what, before);
    return false;
  } finally {
    void queryClient.invalidateQueries({ queryKey: keys.threads });
  }
}

export async function renameThread(id: string, title: string): Promise<boolean> {
  const t = title.trim();
  if (!t) return false;
  return patch(id, { title: t }, { title: t }, 'Renaming');
}

export async function setPinned(id: string, pinned: boolean): Promise<void> {
  if (await patch(id, { pinned }, { pinned }, pinned ? 'Pinning' : 'Unpinning'))
    notify({
      level: 'success',
      title: pinned ? 'Pinned' : 'Unpinned',
      undo: () => void patch(id, { pinned: !pinned }, { pinned: !pinned }, 'Undo'),
    });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** “A”, “B” and 3 more: titles named in a notice, never a wall of them. */
export function nameThem(titles: string[], max = 3): string {
  const shown = titles.slice(0, max).map((t) => `“${t || 'Untitled'}”`);
  const rest = titles.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : (shown[0] ?? '');
}

/** What the person is told about the threads a bulk action left alone. */
export function leftAlone(skipped: BulkSkip[]): string {
  const running = skipped.filter((s) => s.reason === 'running');
  const other = skipped.filter((s) => s.reason !== 'running');
  const parts: string[] = [];
  if (running.length)
    parts.push(
      `Left where ${running.length === 1 ? 'it is' : 'they are'}, answering now: ${nameThem(running.map((s) => s.title))}.`,
    );
  if (other.length) parts.push(`${nameThem(other.map((s) => s.title))}: ${other[0]?.hint ?? ''}`);
  return parts.join(' ');
}

/** The cached list with these threads taken out, or changed, before Core has answered. */
function applyLocal(req: ThreadBulkRequest): void {
  if (req.action === 'revert') return;
  if (req.action === 'archive' || req.action === 'delete') {
    const gone = new Set(req.ids);
    mapList((items) => items.filter((t) => !gone.has(t.id)));
  } else if (req.action === 'move') {
    const moving = new Set(req.ids);
    mapList((items) => items.map((t) => (moving.has(t.id) ? { ...t, notebookId: req.notebook_id } : t)));
  }
}

function refreshAfter(): void {
  for (const key of [keys.threads, keys.archived, keys.notebooks, keys.trash])
    void queryClient.invalidateQueries({ queryKey: key });
}

/**
 * Run one bulk action: the list changes first, Core second, and a failure puts the list back.
 * Returns what Core did, or null when it did not answer.
 */
export async function runBulk(req: ThreadBulkRequest): Promise<ThreadBulkResult | null> {
  const before = snapshot();
  applyLocal(req);
  try {
    return await api.post<ThreadBulkResult>('/threads/bulk', req);
  } catch (error) {
    fail(error, 'That change', before);
    return null;
  } finally {
    refreshAfter();
  }
}

/** Undo: the same call with the states the threads had, so everything returns exactly. */
export async function undoBulk(done: ThreadState[]): Promise<void> {
  const r = await runBulk({ action: 'revert', states: done });
  if (r)
    notify({
      level: 'success',
      title: `Put back ${plural(r.done.length, 'thread')}`,
      ...(r.skipped.length && { body: leftAlone(r.skipped) }),
    });
}

interface BulkSay {
  /** "Archived 3 threads". */
  title: (n: number) => string;
  body?: string;
  /** Nothing changed: "Nothing was archived". */
  none: string;
  onDone?: () => void;
}

/** One bulk action, one toast: what happened to how many, what was left alone, and Undo. */
export async function bulkWithUndo(req: Exclude<ThreadBulkRequest, { action: 'revert' }>, say: BulkSay) {
  const r = await runBulk(req);
  if (!r) return null;
  const left = leftAlone(r.skipped);
  if (r.done.length === 0) {
    if (r.skipped.length) notify({ level: 'warn', title: say.none, body: left });
    return r;
  }
  say.onDone?.();
  notify({
    level: r.skipped.length ? 'warn' : 'success',
    title: say.title(r.done.length),
    body: [say.body, left].filter(Boolean).join(' '),
    ttlMs: UNDO_MS,
    undo: () => void undoBulk(r.done),
  });
  return r;
}

export async function setArchived(id: string, archived: boolean, title?: string): Promise<void> {
  await bulkWithUndo(
    { action: archived ? 'archive' : 'unarchive', ids: [id] },
    {
      title: () => (archived ? 'Archived' : 'Restored from the archive'),
      ...(title && { body: title }),
      none: archived ? 'Not archived' : 'Not restored',
    },
  );
}

/** Many threads into one notebook (null: out of their notebooks). */
export function moveThreads(ids: string[], notebookId: string | null, notebookTitle?: string) {
  return bulkWithUndo(
    { action: 'move', ids, notebook_id: notebookId },
    {
      title: (n) =>
        notebookId
          ? `Moved ${plural(n, 'thread')} to ${notebookTitle ?? 'the notebook'}`
          : `Moved ${plural(n, 'thread')} out of ${n === 1 ? 'its notebook' : 'their notebooks'}`,
      none: 'Nothing was moved',
    },
  );
}

export async function moveThread(id: string, notebookId: string | null, notebookTitle?: string) {
  await moveThreads([id], notebookId, notebookTitle);
}

export function archiveThreads(ids: string[]) {
  return bulkWithUndo(
    { action: 'archive', ids },
    { title: (n) => `Archived ${plural(n, 'thread')}`, none: 'Nothing was archived' },
  );
}

/** Deleting is a move to the Trash: kept 30 days, restorable, and Undo is one press. */
export function deleteThreads(ids: string[], onGone?: () => void) {
  return bulkWithUndo(
    { action: 'delete', ids },
    {
      title: (n) => `Moved ${plural(n, 'thread')} to the Trash`,
      body: `Kept for ${TRASH_DAYS} days.`,
      none: 'Nothing was deleted',
      ...(onGone && { onDone: onGone }),
    },
  );
}

export function deleteThread(id: string, _title: string, onGone?: () => void): void {
  void deleteThreads([id], onGone);
}

/** The branch on screen as markdown: what was asked, who answered, what they said. */
export function threadMarkdown(t: ThreadView): string {
  const lines = [`# ${t.title}`, ''];
  for (const m of t.messages) {
    const who = m.role === 'user' ? 'You' : (m.modelName ?? modelName(m.modelId));
    lines.push(`## ${who}`, '', partsText(m.parts).trim() || '(no text)', '');
  }
  return lines.join('\n');
}

/** Export the thread: opens the dialog (format, and what it holds). */
export function exportThread(id: string): void {
  openExport(id);
}

/** The person has opened the thread: its "new answer" dot goes, here at once and in Core for every device. */
export async function markSeen(id: string): Promise<void> {
  patchLocal(id, { unread: false });
  try {
    await api.post(`/threads/${id}/seen`);
  } catch {
    /* the dot returns on the next refresh; nothing is lost */
  }
}
