/**
 * ------------------------------------------------------------------
 *  Title    |  Query client with a memory
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Come back a week later and the last thread paints from
 *           |  IndexedDB before the network answers (DESIGN.md §13.4).
 *  How      |  TanStack Query persisted through idb-keyval, without
 *           |  large or live queries and with threads cut to their
 *           |  last messages (trimForPersist). A buster
 *           |  string invalidates the cache on schema changes.
 * ------------------------------------------------------------------
 */

import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient } from '@tanstack/react-query';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';
import { ApiCallError, OfflineError } from './api';

// v3: threads are paged and the persisted cache trimmed; drops the old, oversized one.
export const CACHE_BUSTER = 'ancile-cockpit-v3';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 1000 * 60 * 60 * 24 * 7,
      // Retry only what a retry can fix: a transient server error. Offline
      // falls back to demo data at once; a 4xx or 501 will answer the same
      // way every time, and retrying it only delays the error screen.
      retry: (count, error) =>
        count < 2 &&
        !(error instanceof OfflineError) &&
        !(error instanceof ApiCallError && (error.status < 500 || error.status === 501)),
      refetchOnWindowFocus: true,
    },
  },
});

/**
 * Queries never written to IndexedDB: large, live, or cheap to ask again.
 * Writing them meant serialising megabytes on every change (a long Claude
 * Code thread, a source's text) for a cache nobody reads from.
 */
const NOT_PERSISTED = new Set([
  'tree',
  'budget',
  'sources',
  'source',
  'source-content',
  'claude-code',
  'system-health',
  // Whether Core started: asked fresh on every load.
  'startup',
]);
/** Threads kept for an instant first paint: the most recent few, their last messages only. */
export const PERSIST_THREADS = 8;
export const PERSIST_THREAD_TAIL = 20;
/** One query larger than this (characters) is not kept; the whole cache stops at the second figure. */
export const PERSIST_QUERY_MAX = 300_000;
export const PERSIST_TOTAL_MAX = 4_000_000;

/** Whether a query may be persisted at all (the provider's shouldDehydrateQuery). */
export function persistable(queryKey: readonly unknown[], status: string): boolean {
  if (status !== 'success') return false;
  const head = queryKey[0];
  return typeof head !== 'string' || !NOT_PERSISTED.has(head);
}

type Dehydrated = PersistedClient['clientState']['queries'][number];
interface ThreadLike {
  messages?: unknown[];
  cursor?: string | null;
  hasMore?: boolean;
}

/**
 * What is written: thread queries cut to their last messages (the rest
 * loads again on open), only the most recent threads, nothing oversized,
 * and the newest queries first until the total cap.
 */
export function trimForPersist(client: PersistedClient): PersistedClient {
  const threads = client.clientState.queries
    .filter((q) => q.queryKey[0] === 'thread')
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .slice(0, PERSIST_THREADS);
  const keepThreads = new Set(threads);
  const out: { q: Dehydrated; size: number }[] = [];
  for (const q of client.clientState.queries) {
    if (!persistable(q.queryKey, q.state.status)) continue;
    let next = q;
    if (q.queryKey[0] === 'thread') {
      if (!keepThreads.has(q)) continue;
      const data = q.state.data as ThreadLike | undefined;
      const msgs = data?.messages;
      if (Array.isArray(msgs) && msgs.length > PERSIST_THREAD_TAIL) {
        const tail = msgs.slice(-PERSIST_THREAD_TAIL) as { id?: string }[];
        next = {
          ...q,
          state: {
            ...q.state,
            data: { ...data, messages: tail, cursor: tail[0]?.id ?? null, hasMore: true },
          },
        };
      }
    }
    const size = JSON.stringify(next.state.data ?? null).length;
    if (size > PERSIST_QUERY_MAX) continue;
    out.push({ q: next, size });
  }
  out.sort((a, b) => b.q.state.dataUpdatedAt - a.q.state.dataUpdatedAt);
  let total = 0;
  const queries: Dehydrated[] = [];
  for (const { q, size } of out) {
    if (total + size > PERSIST_TOTAL_MAX) continue;
    total += size;
    queries.push(q);
  }
  return { ...client, clientState: { ...client.clientState, queries } };
}

export const persister = createAsyncStoragePersister({
  storage: {
    getItem: (key: string) => get<string>(key).then((v) => v ?? null),
    setItem: (key: string, value: string) => set(key, value),
    removeItem: (key: string) => del(key),
  },
  key: 'nvx.ancile.query',
  // A streaming answer changes the cache many times a second; write at most every few seconds.
  throttleTime: 3_000,
  serialize: (client) => JSON.stringify(trimForPersist(client)),
});
