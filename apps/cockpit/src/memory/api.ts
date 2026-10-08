/**
 * ------------------------------------------------------------------
 *  Title    |  Memory data
 *  Ref      |  DESIGN.md §6, §4.1 (Memory routes)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every read and write the Memory screens make, and what
 *           |  the global event stream does when memory changes on its
 *           |  own (a toast with Undo, or a nudge to the inbox).
 *  How      |  React Query over /api/v1/memory/*. Writes invalidate the
 *           |  whole ['memory'] family: files, entries and history all
 *           |  move together when one commit lands.
 *  Note     |  A small store remembers which tab and file are open, so
 *           |  a toast's "Review" lands on the inbox.
 * ------------------------------------------------------------------
 */

import type {
  MemoryCommit,
  MemoryDiff,
  MemoryFileContent,
  MemoryFileList,
  MemoryPreview,
  MemoryProposal,
  MemoryProposalList,
  MemorySettings,
  PutMemoryFileResponse,
} from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { ApiCallError, api } from '../lib/api';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';

export const memoryKeys = {
  all: ['memory'] as const,
  files: ['memory', 'files'] as const,
  file: (path: string) => ['memory', 'file', path] as const,
  history: (path: string | null) => ['memory', 'history', path ?? '*'] as const,
  proposals: ['memory', 'proposals'] as const,
  settings: ['memory', 'settings'] as const,
  diff: (a: string, b: string, path: string | null) => ['memory', 'diff', a, b, path ?? '*'] as const,
};

const enc = (path: string) => path.split('/').map(encodeURIComponent).join('/');
export const refreshMemory = () => queryClient.invalidateQueries({ queryKey: memoryKeys.all });

export type MemoryTab = 'files' | 'inbox' | 'history';

interface MemoryUi {
  tab: MemoryTab;
  path: string | null;
  setTab: (tab: MemoryTab) => void;
  open: (path: string | null) => void;
}

export const useMemoryUi = create<MemoryUi>((set) => ({
  tab: 'files',
  path: null,
  setTab: (tab) => set({ tab }),
  open: (path) => set({ path, tab: 'files' }),
}));

/* ---- Reads ------------------------------------------------------------------ */

export const useMemoryFiles = () =>
  useQuery({ queryKey: memoryKeys.files, queryFn: () => api.get<MemoryFileList>('/memory/files') });

export const useMemoryFile = (path: string | null) =>
  useQuery({
    queryKey: memoryKeys.file(path ?? ''),
    queryFn: () => api.get<MemoryFileContent>(`/memory/files/${enc(path as string)}`),
    enabled: !!path,
  });

export const useMemoryHistory = (path: string | null) =>
  useQuery({
    queryKey: memoryKeys.history(path),
    queryFn: async () =>
      (
        await api.get<{ items: MemoryCommit[] }>(
          path ? `/memory/history/${enc(path)}?limit=100` : '/memory/log?limit=100',
        )
      ).items,
  });

export const useProposals = () =>
  useQuery({
    queryKey: memoryKeys.proposals,
    queryFn: () => api.get<MemoryProposalList>('/memory/proposals'),
  });

export const usePendingProposals = () => useProposals().data?.pending ?? 0;

export const useMemorySettings = () =>
  useQuery({ queryKey: memoryKeys.settings, queryFn: () => api.get<MemorySettings>('/memory/settings') });

/** What one commit changed (b alone), or the difference between two. */
export const useMemoryDiff = (b: string | null, a: string | null = null, path: string | null = null) =>
  useQuery({
    queryKey: memoryKeys.diff(a ?? '', b ?? '', path),
    queryFn: () => {
      const q = new URLSearchParams({ b: b as string, ...(a && { a }), ...(path && { path }) });
      return api.get<MemoryDiff>(`/memory/diff?${q}`);
    },
    enabled: !!b,
    staleTime: Number.POSITIVE_INFINITY,
  });

export const fetchPreview = (q: { thread?: string; q?: string }) => {
  const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
  return api.get<MemoryPreview>(`/memory/preview?${p}`);
};

/* ---- Writes ----------------------------------------------------------------- */

export function failed(error: unknown, what: string) {
  notify({
    level: 'error',
    title: error instanceof ApiCallError ? error.body.error.title : `${what} failed`,
    body:
      error instanceof ApiCallError
        ? error.body.error.hint
        : 'Check that NVX Ancile is running, then try again.',
  });
}

export function saveFile(path: string, content: string, base: string | null, message?: string) {
  return api.put<PutMemoryFileResponse>(`/memory/files/${enc(path)}`, {
    content,
    base_sha: base,
    ...(message?.trim() && { message: message.trim() }),
  });
}

export function useDecide() {
  return useMutation({
    mutationFn: (v: { id: string; decision: 'approve' | 'reject' | 'undo'; text?: string }) =>
      api.post<MemoryProposal>(`/memory/proposals/${v.id}`, {
        decision: v.decision,
        ...(v.text && { text: v.text }),
      }),
    onSuccess: () => void refreshMemory(),
    onError: (e) => failed(e, 'That'),
  });
}

export function useRevert() {
  return useMutation({
    mutationFn: (sha: string) => api.post<{ version: string }>('/memory/revert', { sha }),
    onSuccess: () => {
      void refreshMemory();
      notify({
        level: 'success',
        title: 'Change undone',
        body: 'A new commit puts the file back as it was.',
      });
    },
    onError: (e) => failed(e, 'Undoing that change'),
  });
}

export function useSetCapture() {
  return useMutation({
    mutationFn: (capture: MemorySettings['capture']) =>
      api.put<MemorySettings>('/memory/settings', { capture }),
    onMutate: (capture) => queryClient.setQueryData(memoryKeys.settings, { capture }),
    onError: (e) => {
      void queryClient.invalidateQueries({ queryKey: memoryKeys.settings });
      failed(e, 'Changing how memory learns');
    },
  });
}

/* ---- From the event stream -------------------------------------------------- */

/** memory.proposal on /events: refresh, then a quiet toast with Undo, or a nudge to the inbox. */
export function onMemoryProposal(
  e: { proposal_id: string; auto_applied: boolean; text?: string | undefined; target_path: string },
  go: (to: string) => void,
) {
  void refreshMemory();
  const where = e.target_path === 'USER.md' ? 'about you' : e.target_path.replace(/\.md$/, '');
  if (e.auto_applied) {
    notify({
      id: `memory-${e.proposal_id}`,
      level: 'success',
      title: 'Remembered',
      body: e.text ? `${e.text} (${where})` : `Added to ${where}.`,
      undo: () => {
        api
          .post(`/memory/proposals/${e.proposal_id}`, { decision: 'undo' })
          .then(() => {
            void refreshMemory();
            notify({ level: 'info', title: 'Forgotten', body: 'That entry was taken out again.' });
          })
          .catch((err) => failed(err, 'Undo'));
      },
    });
    return;
  }
  notify({
    id: `memory-${e.proposal_id}`,
    level: 'info',
    title: 'Something to remember?',
    body: e.text ?? 'NVX Ancile has a suggestion for your memory.',
    action: {
      label: 'Review',
      run: () => {
        useMemoryUi.getState().setTab('inbox');
        go('/admin/memory');
      },
    },
  });
}
