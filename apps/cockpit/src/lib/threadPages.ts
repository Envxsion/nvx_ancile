/**
 * ------------------------------------------------------------------
 *  Title    |  A thread a page at a time
 *  Ref      |  docs/api.md (Read a long thread a page at a time)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A thread imported from Claude Code can hold thousands
 *           |  of messages. Opening it loads the last page; scrolling
 *           |  up loads the one before; jumping to an old message
 *           |  loads from there. The thread query stays one ThreadView,
 *           |  so everything that reads or patches it is unchanged.
 *  How      |  Pure merges over ThreadView plus three loaders. A
 *           |  refetch asks for the last page only and keeps what was
 *           |  loaded above it: a path is decided by its messages, so
 *           |  if the new page's first message is already loaded,
 *           |  everything above it is the same.
 * ------------------------------------------------------------------
 */

import type { ThreadPath } from '@nvx/contracts';
import { api } from './api';
import { toThreadView } from './mappers';
import { queryClient } from './query';
import type { ThreadView } from './types';

/** Messages per page: a few screens, small enough to paint at once. */
export const THREAD_PAGE = 60;

const key = (id: string) => ['thread', id] as const;

/** The path's last page, as the thread query loads it. */
export function threadPagePath(id: string, extra = ''): string {
  return `/threads/${id}/path?limit=${THREAD_PAGE}${extra}`;
}

/**
 * A fresh last page over what was loaded: keep the earlier messages when
 * the page starts at a message already loaded (the same path), else the
 * page alone (another branch, or a thread changed underneath).
 */
export function mergeTail(prev: ThreadView | undefined, next: ThreadView): ThreadView {
  if (!prev?.cursor || !next.cursor || prev.cursor === next.cursor) return next;
  const at = prev.messages.findIndex((m) => m.id === next.cursor);
  if (at <= 0) return next;
  return {
    ...next,
    messages: [...prev.messages.slice(0, at), ...next.messages],
    cursor: prev.cursor,
    hasMore: prev.hasMore ?? false,
  };
}

/** An earlier page in front of what is loaded. */
export function prependPage(cur: ThreadView, earlier: ThreadView): ThreadView {
  const have = new Set(cur.messages.map((m) => m.id));
  const fresh = earlier.messages.filter((m) => !have.has(m.id));
  return {
    ...cur,
    messages: [...fresh, ...cur.messages],
    cursor: earlier.cursor ?? cur.cursor ?? null,
    hasMore: earlier.hasMore ?? false,
    total: earlier.total ?? cur.total,
  };
}

/** The query function for a thread: its last page, merged over what is loaded. */
export async function fetchThreadTail(id: string): Promise<ThreadView> {
  const page = toThreadView(await api.get<ThreadPath>(threadPagePath(id)));
  return mergeTail(queryClient.getQueryData<ThreadView>(key(id)), page);
}

const loading = new Map<string, Promise<boolean>>();

async function loadBefore(id: string, include?: string): Promise<boolean> {
  const cur = queryClient.getQueryData<ThreadView>(key(id));
  if (!cur?.hasMore || !cur.cursor) return false;
  const head = cur.headId ? `&head=${encodeURIComponent(cur.headId)}&exact=1` : '';
  const more = include ? `&include=${encodeURIComponent(include)}` : '';
  let earlier: ThreadView;
  try {
    earlier = toThreadView(
      await api.get<ThreadPath>(
        threadPagePath(id, `&before=${encodeURIComponent(cur.cursor)}${head}${more}`),
      ),
    );
  } catch {
    // The path changed under us (another branch, a delete): start again from the head.
    await queryClient.invalidateQueries({ queryKey: key(id) });
    return false;
  }
  const now = queryClient.getQueryData<ThreadView>(key(id));
  // Only if nothing else replaced the loaded window meanwhile.
  if (!now || now.cursor !== cur.cursor) return false;
  queryClient.setQueryData<ThreadView>(key(id), prependPage(now, earlier));
  return true;
}

/** Load the page before the first loaded message. One at a time per thread. */
export function loadEarlier(id: string): Promise<boolean> {
  const running = loading.get(id);
  if (running) return running;
  const p = loadBefore(id).finally(() => loading.delete(id));
  loading.set(id, p);
  return p;
}

/** Make sure `messageId` is loaded (jump to an old message). True when it is. */
export async function ensureLoaded(id: string, messageId: string): Promise<boolean> {
  const has = () => !!queryClient.getQueryData<ThreadView>(key(id))?.messages.some((m) => m.id === messageId);
  if (has()) return true;
  await loading.get(id);
  if (has()) return true;
  const p = loadBefore(id, messageId).finally(() => loading.delete(id));
  loading.set(id, p);
  await p;
  return has();
}

export interface ReadingAnchor {
  id: string;
  /** How far the message's top sits above the top of the view (pixels). */
  offset: number;
}

/**
 * The message you are reading: the first whose bottom is below the top of
 * the view. `rows` are in order, so this is a binary search, not a walk
 * over thousands of rows on every scroll event.
 */
export function readingAnchor(
  count: number,
  at: (i: number) => { id: string; top: number; height: number },
  scrollTop: number,
): ReadingAnchor | null {
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = at(mid);
    if (r.top + r.height > scrollTop) {
      found = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  if (found < 0) return null;
  const r = at(found);
  return { id: r.id, offset: r.top - scrollTop };
}

/** scrollTop that puts the anchor message back where it was (after a page was added above). */
export function scrollTopFor(anchor: ReadingAnchor, topOf: (id: string) => number | null): number | null {
  const top = topOf(anchor.id);
  return top === null ? null : top - anchor.offset;
}
