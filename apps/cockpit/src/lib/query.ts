/**
 * ------------------------------------------------------------------
 *  Title    |  Query client with a memory
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Come back a week later and the last thread paints from
 *           |  IndexedDB before the network answers (DESIGN.md §13.4).
 *  How      |  TanStack Query persisted through idb-keyval. A buster
 *           |  string invalidates the cache on schema changes.
 * ------------------------------------------------------------------
 */

import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient } from '@tanstack/react-query';
import { del, get, set } from 'idb-keyval';
import { ApiCallError, OfflineError } from './api';

export const CACHE_BUSTER = 'ancile-cockpit-v2';

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

export const persister = createAsyncStoragePersister({
  storage: {
    getItem: (key: string) => get<string>(key).then((v) => v ?? null),
    setItem: (key: string, value: string) => set(key, value),
    removeItem: (key: string) => del(key),
  },
  key: 'nvx.ancile.query',
  throttleTime: 1_000,
});
