/**
 * ------------------------------------------------------------------
 *  Title    |  Thread actions
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Rename, pin, archive, move and delete, from the rail,
 *           |  the palette or the thread itself, each instant and each
 *           |  undoable.
 *  How      |  Optimistic: the cached list changes first, Core second,
 *           |  and a failure rolls the cache back with a toast. Delete
 *           |  waits out its undo window before Core hears of it, so
 *           |  Undo is a real undo, not a restore.
 * ------------------------------------------------------------------
 */

import type { InfiniteData } from '@tanstack/react-query';
import { notify } from '../state/notify';
import { ApiCallError, api } from './api';
import { keys } from './data';
import { modelName } from './format';
import { partsText } from './mappers';
import { queryClient } from './query';
import type { ThreadSummary, ThreadView } from './types';

interface Page {
  items: ThreadSummary[];
  next: string | null;
}
type List = InfiniteData<Page, string | null>;

const UNDO_MS = 6_000;

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

export async function setArchived(id: string, archived: boolean, title?: string): Promise<void> {
  const before = snapshot();
  if (archived) mapList((items) => items.filter((t) => t.id !== id));
  try {
    await api.patch(`/threads/${id}`, { archived });
    void queryClient.invalidateQueries({ queryKey: keys.archived });
    notify({
      level: 'success',
      title: archived ? 'Archived' : 'Restored from the archive',
      ...(title && { body: title }),
      undo: () => void setArchived(id, !archived),
    });
  } catch (error) {
    fail(error, archived ? 'Archiving' : 'Restoring', before);
  } finally {
    void queryClient.invalidateQueries({ queryKey: keys.threads });
  }
}

export async function moveThread(id: string, notebookId: string | null, notebookTitle?: string) {
  if (await patch(id, { notebook_id: notebookId }, { notebookId }, notebookId ? 'Moving' : 'Taking it out')) {
    void queryClient.invalidateQueries({ queryKey: keys.notebooks });
    notify({
      level: 'success',
      title: notebookId ? `Moved to ${notebookTitle ?? 'the notebook'}` : 'Moved out of the notebook',
    });
  }
}

const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();

/** Gone from the list now; gone from Core when the undo window closes. */
export function deleteThread(id: string, title: string, onGone?: () => void): void {
  const before = snapshot();
  mapList((items) => items.filter((t) => t.id !== id));
  onGone?.();
  const commit = async () => {
    pendingDeletes.delete(id);
    try {
      await api.del(`/threads/${id}`);
      queryClient.removeQueries({ queryKey: keys.thread(id) });
    } catch (error) {
      fail(error, 'Deleting', before);
    }
  };
  pendingDeletes.set(
    id,
    setTimeout(() => void commit(), UNDO_MS),
  );
  notify({
    level: 'info',
    title: 'Thread deleted',
    body: title,
    undo: () => {
      const t = pendingDeletes.get(id);
      if (!t) return;
      clearTimeout(t);
      pendingDeletes.delete(id);
      queryClient.setQueryData(keys.threads, before);
    },
  });
}

/** Leaving the page commits any delete still waiting out its undo window. */
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const [id, t] of pendingDeletes) {
      clearTimeout(t);
      void fetch(`/api/v1/threads/${id}`, { method: 'DELETE', keepalive: true });
    }
  });
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

/** Save the thread on screen as a .md file. */
export function exportThread(id: string): void {
  const t = queryClient.getQueryData<ThreadView>(keys.thread(id));
  if (!t) {
    notify({
      level: 'warn',
      title: 'Open the thread first',
      body: 'Export saves the branch you are looking at.',
    });
    return;
  }
  const blob = new Blob([threadMarkdown(t)], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${
    t.title
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .slice(0, 80) || 'thread'
  }.md`;
  a.click();
  URL.revokeObjectURL(a.href);
  notify({ level: 'success', title: 'Thread exported', body: `${a.download} is in your downloads.` });
}
