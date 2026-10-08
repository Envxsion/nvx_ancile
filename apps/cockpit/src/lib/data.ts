/**
 * ------------------------------------------------------------------
 *  Title    |  Data hooks
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every screen reads through these, so the switch from
 *           |  demo fixtures to the real API is one file.
 *  How      |  Each hook asks Core. Wire shapes become view shapes in
 *           |  lib/mappers.ts. A browser that has never reached Core
 *           |  shows the sample workspace ("Demo data"); once Core has
 *           |  answered, an outage keeps your last data on screen with
 *           |  the offline banner, and fixtures never enter the cache.
 * ------------------------------------------------------------------
 */

import type {
  Approval,
  ModelInfo,
  Note,
  Notebook,
  SetupStatus,
  Source,
  SourceContent,
  ThreadPath,
  ThreadSummary as WireThreadSummary,
} from '@nvx/contracts';
import { queryOptions, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import * as demo from '../fixtures/demo';
import { useUi } from '../state/ui';
import { ApiCallError, api, OfflineError } from './api';
import { useConnection } from './connection';
import {
  toModelView,
  toNotebookView,
  toPendingApproval,
  toSourceView,
  toThreadSummary,
  toThreadView,
} from './mappers';
import type {
  ModelView,
  NotebookView,
  PendingApproval,
  SourceView,
  ThreadSummary,
  ThreadView,
} from './types';

/**
 * Demo data stands in only on a browser that has never reached Core: the
 * sample workspace shows what NVX Ancile is before it is installed, and
 * the status bar says "Demo data". After Core has answered once, being
 * offline throws, so React Query keeps the last real data and the banner
 * says Core is not answering. A route Core answers 501 for (planned for a
 * later phase) is simply empty: sample notebooks in a real session would
 * pass fiction off as yours. Every other error is real.
 */
async function orDemo<T>(call: () => Promise<T>, fixture: T, notBuilt?: T): Promise<T> {
  try {
    const value = await call();
    useUi.getState().setDemo(false);
    return value;
  } catch (error) {
    if (error instanceof OfflineError && !useConnection.getState().everOnline) {
      useUi.getState().setDemo(true);
      return fixture;
    }
    if (
      error instanceof ApiCallError &&
      (error.body.error.code === 'not_implemented' || error.status === 501)
    )
      return notBuilt ?? fixture;
    throw error;
  }
}

export const keys = {
  threads: ['threads'] as const,
  archived: ['archived-threads'] as const,
  notebooks: ['notebooks'] as const,
  thread: (id: string) => ['thread', id] as const,
  sources: (notebookId: string) => ['sources', notebookId] as const,
  source: (id: string) => ['source', id] as const,
  sourceContent: (id: string) => ['source-content', id] as const,
  notes: (notebookId: string) => ['notes', notebookId] as const,
  models: ['models'] as const,
  approvals: ['approvals'] as const,
  setup: ['setup'] as const,
};

interface ThreadPage {
  items: ThreadSummary[];
  next: string | null;
}

/**
 * Threads, newest first, a page at a time. `data` is the flat list loaded
 * so far; `more()` fetches the next page when the rail nears its end.
 */
export function useThreads() {
  const q = useInfiniteQuery({
    queryKey: keys.threads,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      orDemo<ThreadPage>(
        () =>
          api
            .get<{ items: WireThreadSummary[]; next_cursor: string | null }>(
              `/threads?limit=100${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
            )
            .then((r) => ({ items: r.items.map(toThreadSummary), next: r.next_cursor ?? null })),
        { items: demo.threads, next: null },
      ),
    getNextPageParam: (last) => last.next,
  });
  const data = useMemo(() => q.data?.pages.flatMap((p) => p.items), [q.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;
  return {
    data,
    isPending: q.isPending,
    /** Only an error with nothing to show: a failed refresh keeps the list. */
    isError: q.isError && !data,
    error: q.error,
    refetch: q.refetch,
    hasMore: hasNextPage,
    loadingMore: isFetchingNextPage,
    more: () => {
      if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
    },
  };
}

export function useArchivedThreads(enabled: boolean) {
  return useQuery({
    queryKey: keys.archived,
    enabled,
    queryFn: () =>
      api
        .get<{ items: WireThreadSummary[] }>('/threads?archived=1&limit=200')
        .then((r) => r.items.map(toThreadSummary)),
  });
}

export function useNotebooks() {
  return useQuery({
    queryKey: keys.notebooks,
    queryFn: () =>
      orDemo<NotebookView[]>(
        () => api.get<{ items: Notebook[] }>('/notebooks').then((r) => r.items.map(toNotebookView)),
        demo.notebooks,
        [],
      ),
  });
}

export function useNotes(notebookId: string | null | undefined) {
  return useQuery({
    queryKey: keys.notes(notebookId ?? 'none'),
    enabled: Boolean(notebookId),
    queryFn: () =>
      orDemo<Note[]>(
        () => api.get<{ items: Note[] }>(`/notebooks/${notebookId}/notes`).then((r) => r.items),
        [],
        [],
      ),
  });
}

/** Shared so hovering a thread in the rail can prefetch exactly this query. */
export const threadQuery = (id: string) =>
  queryOptions({
    queryKey: keys.thread(id),
    queryFn: () =>
      orDemo<ThreadView>(() => api.get<ThreadPath>(`/threads/${id}/path`).then(toThreadView), demoThread(id)),
  });

/** The one fully written demo thread, or an empty one with the right title. */
function demoThread(id: string): ThreadView {
  if (id === demo.thread.id) return demo.thread;
  const summary = demo.threads.find((t) => t.id === id);
  return { id, title: summary?.title ?? 'New thread', notebookId: summary?.notebookId ?? null, messages: [] };
}

export function useThread(id: string | undefined) {
  return useQuery({ ...threadQuery(id ?? 'none'), enabled: Boolean(id) });
}

/** Every configured model with whether it can answer now. */
export function useModels() {
  return useQuery({
    queryKey: keys.models,
    staleTime: 60_000,
    queryFn: () =>
      orDemo<ModelView[]>(
        () =>
          api
            .get<{ items: ModelInfo[] }>('/models')
            .then((r) =>
              r.items
                .filter((m) => !m.capabilities.includes('embeddings') && !m.capabilities.includes('rerank'))
                .map(toModelView),
            ),
        demo.models,
      ),
  });
}

/** Decisions the agent is waiting on, oldest first. */
export function useApprovals() {
  return useQuery({
    queryKey: keys.approvals,
    queryFn: () =>
      orDemo<PendingApproval[]>(
        () => api.get<{ items: Approval[] }>('/approvals').then((r) => r.items.map(toPendingApproval)),
        [demo.approval],
      ),
  });
}

export function useSetup() {
  return useQuery({
    queryKey: keys.setup,
    staleTime: 0,
    queryFn: () => api.get<SetupStatus>('/setup'),
    retry: false,
  });
}

export interface SystemHealth {
  status: 'ok' | 'degraded' | 'down';
  /** Plain words for the status bar, naming the service when one is unwell. */
  summary: string;
  services: { service: string; status: string; last_error: string | null; needs_attention: boolean }[];
}

const SERVICE_NAMES: Record<string, string> = {
  postgres: 'The database',
  knowledge: 'Knowledge',
  notebook: 'Notebooks',
  agent: 'The lab',
  controller: 'The Controller',
  disk: 'Disk space',
};

function summarise(services: SystemHealth['services']): SystemHealth {
  const down = services.filter((s) => s.status === 'down');
  const degraded = services.filter((s) => s.status === 'degraded' || s.status === 'restarting');
  const name = (s: { service: string }) => SERVICE_NAMES[s.service] ?? s.service;
  const [firstDown] = down;
  const [firstDegraded] = degraded;
  if (firstDown)
    return {
      status: 'down',
      summary: down.length === 1 ? `${name(firstDown)} is down` : `${down.length} services are down`,
      services,
    };
  if (firstDegraded)
    return {
      status: 'degraded',
      summary:
        degraded.length === 1 ? `${name(firstDegraded)} is degraded` : `${degraded.length} services degraded`,
      services,
    };
  return { status: 'ok', summary: 'All systems well', services };
}

/** The status bar's health dot: Core's supervisor, polled every 15 s. */
export function useSystemHealth() {
  return useQuery({
    queryKey: ['system-health'],
    refetchInterval: 15_000,
    queryFn: async (): Promise<SystemHealth> => {
      try {
        const r = await api.get<{ services: SystemHealth['services'] }>('/system/health');
        return summarise(r.services);
      } catch (error) {
        if (error instanceof OfflineError)
          return { status: 'down', summary: 'Core is not answering', services: [] };
        throw error;
      }
    },
  });
}

/** A notebook's sources. While any is still being read, poll gently as a backstop to progress events. */
export function useSources(notebookId: string | null | undefined) {
  return useQuery({
    queryKey: keys.sources(notebookId ?? 'none'),
    enabled: Boolean(notebookId),
    refetchInterval: (q) =>
      q.state.data?.some((s) => !['ready', 'failed', 'stale'].includes(s.status)) ? 4_000 : false,
    queryFn: () =>
      orDemo<SourceView[]>(
        () =>
          api
            .get<{ items: Source[] }>(`/notebooks/${notebookId}/sources`)
            .then((r) => r.items.map(toSourceView)),
        notebookId === demo.notebooks[0]?.id ? demo.sources : [],
        [],
      ),
  });
}

/** The extracted text of one source, for the viewer and citation jumps. */
export function useSourceContent(sourceId: string | null | undefined) {
  return useQuery({
    queryKey: keys.sourceContent(sourceId ?? 'none'),
    enabled: Boolean(sourceId),
    staleTime: 5 * 60_000,
    queryFn: () => api.get<SourceContent>(`/sources/${sourceId}/content`),
  });
}

export function useSource(sourceId: string | null | undefined) {
  return useQuery({
    queryKey: keys.source(sourceId ?? 'none'),
    enabled: Boolean(sourceId),
    queryFn: () => api.get<Source>(`/sources/${sourceId}`).then(toSourceView),
  });
}
