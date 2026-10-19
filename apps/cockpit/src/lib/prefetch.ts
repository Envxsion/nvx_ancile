/**
 * ------------------------------------------------------------------
 *  Title    |  Data ahead of a click
 *  Ref      |  ROADMAP P5
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Hovering or focusing a link to a thread or notebook
 *           |  already fetched its code. This fetches its data too, so
 *           |  the screen opens full instead of on a skeleton.
 *  How      |  The thread and notebook routes call prefetchThread and
 *           |  prefetchNotebook from their loaders. TanStack Router runs
 *           |  a loader for a link only after the pointer or focus has
 *           |  rested on it for PRELOAD_DELAY_MS, drops it if the
 *           |  pointer leaves first, and reuses the result for a while,
 *           |  so a link is prefetched once per hover and never for rows
 *           |  that are only on screen. The palette, which navigates
 *           |  without links, calls the same functions for the item it
 *           |  has highlighted (paletteTarget, after the same delay).
 *           |  They use the very queries the screens use, so the screen
 *           |  finds the data in the cache.
 *  Note     |  Never throws and never blocks: a deleted thread, a
 *           |  notebook you may not read or a Core that is not answering
 *           |  leave the cache as it was, and the click then shows the
 *           |  screen's own error. Nothing is fetched while offline or
 *           |  in the sample workspace.
 * ------------------------------------------------------------------
 */

import { useUi } from '../state/ui';
import { useConnection } from './connection';
import { notesQuery, sourcesQuery, threadQuery } from './data';
import { queryClient } from './query';

/** How long a pointer or focus rests on a link before its data is fetched. */
export const PRELOAD_DELAY_MS = 150;

function canPrefetch(): boolean {
  return !useUi.getState().demo && useConnection.getState().status === 'online';
}

/** The thread's last page, as the thread screen asks for it. */
export function prefetchThread(threadId: string | undefined): void {
  if (!threadId || !canPrefetch()) return;
  void queryClient.prefetchQuery(threadQuery(threadId));
}

/** What the notebook screen reads that the lists do not already hold: its sources and notes. */
export function prefetchNotebook(notebookId: string | undefined): void {
  if (!notebookId || !canPrefetch()) return;
  void queryClient.prefetchQuery(sourcesQuery(notebookId));
  void queryClient.prefetchQuery(notesQuery(notebookId));
}

/** The thread route's loader: starts the fetch and returns, so a click never waits for it. */
export const loadThread = ({ params }: { params: { threadId: string } }): void =>
  prefetchThread(params.threadId);

/** The notebook route's loader, likewise. */
export const loadNotebook = ({ params }: { params: { notebookId: string } }): void =>
  prefetchNotebook(params.notebookId);

export type PaletteTarget = { kind: 'thread' | 'notebook'; id: string };

/**
 * The thread or notebook a palette item opens, from the item's `value` (cmdk gives the highlighted
 * item's). Items are "thread <id> <title>", "notebook <id> <title>" and, in Recent,
 * "recent thread:<id> <title>". Everything else (commands, models, messages) opens no data.
 */
export function paletteTarget(value: string): PaletteTarget | null {
  const m = /^(?:recent (thread|notebook):|(thread|notebook) )(\S+)/.exec(value);
  if (!m) return null;
  return { kind: (m[1] ?? m[2]) as PaletteTarget['kind'], id: m[3] as string };
}

/** Prefetch for a palette target. */
export function prefetchTarget(t: PaletteTarget): void {
  if (t.kind === 'thread') prefetchThread(t.id);
  else prefetchNotebook(t.id);
}
