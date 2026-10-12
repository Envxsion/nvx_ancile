/**
 * ------------------------------------------------------------------
 *  Title    |  Notebook merge and context links: the calls
 *  Ref      |  docs/notebooks.md · contracts notebooks.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Preview, apply and undo a merge; read a notebook's
 *           |  merge history; list, make and remove context links on
 *           |  a thread or a notebook.
 *  How      |  TanStack Query for reads; plain calls for writes that
 *           |  refresh what they change and say what went wrong in
 *           |  Core's own words (title and hint).
 * ------------------------------------------------------------------
 */

import type {
  ContextLink,
  ContextLinkList,
  MergeInstructionsChoice,
  NotebookMerge,
  NotebookMergePreview,
} from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { ApiCallError, api } from '../lib/api';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';

const enc = encodeURIComponent;

function report(error: unknown, what: string): void {
  if (error instanceof ApiCallError)
    notify({ level: 'error', title: error.body.error.title, body: error.body.error.hint });
  else
    notify({
      level: 'error',
      title: `${what} didn't reach Core`,
      body: 'Check that NVX Ancile is running, then try again.',
    });
}

export const mergeKeys = {
  preview: (into: string, from: string) => ['notebook-merge', 'preview', into, from] as const,
  history: (id: string) => ['notebook-merge', 'history', id] as const,
};

export const linkKeys = {
  of: (kind: 'thread' | 'notebook', id: string) => ['context-links', kind, id] as const,
};

/** What merging `from` into `into` would do. Nothing changes until the merge is applied. */
export function useMergePreview(into: string, from: string | null) {
  return useQuery({
    queryKey: mergeKeys.preview(into, from ?? ''),
    enabled: !!from,
    queryFn: () =>
      api.get<NotebookMergePreview>(`/notebooks/${enc(into)}/merge-preview?from=${enc(from ?? '')}`),
    retry: false,
    staleTime: 0,
  });
}

/** Merges into or out of this notebook, newest first. Nothing in demo data. */
export function useMergeHistory(notebookId: string) {
  const demo = useUi((s) => s.demo);
  return useQuery({
    queryKey: mergeKeys.history(notebookId),
    enabled: !demo,
    queryFn: () =>
      api.get<{ items: NotebookMerge[] }>(`/notebooks/${enc(notebookId)}/merges`).then((r) => r.items),
    retry: false,
  });
}

const refreshAll = async (notebookId: string) => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.notebooks }),
    queryClient.invalidateQueries({ queryKey: keys.threads }),
    queryClient.invalidateQueries({ queryKey: mergeKeys.history(notebookId) }),
    queryClient.invalidateQueries({ queryKey: ['notebook-merge'] }),
  ]);
};

export async function undoMerge(merge: NotebookMerge): Promise<boolean> {
  try {
    await api.post<NotebookMerge>(`/notebook-merges/${enc(merge.id)}/undo`);
    await refreshAll(merge.into_id);
    notify({ level: 'success', title: `${merge.from_title} is back as its own notebook` });
    return true;
  } catch (error) {
    report(error, 'Undoing the merge');
    return false;
  }
}

export async function applyMerge(
  into: string,
  from: string,
  instructions: MergeInstructionsChoice,
): Promise<NotebookMerge | null> {
  try {
    const m = await api.post<NotebookMerge>(`/notebooks/${enc(into)}/merge`, { from_id: from, instructions });
    await refreshAll(into);
    notify({
      level: 'success',
      title: `Merged ${m.from_title} into this notebook`,
      body: `You can undo it from this notebook's history until ${new Date(m.undo_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.`,
      action: { label: 'Undo merge', run: () => void undoMerge(m) },
    });
    return m;
  } catch (error) {
    report(error, 'The merge');
    return null;
  }
}

/** Both ends of a thread's or notebook's links. Nothing in demo data. */
export function useContextLinks(kind: 'thread' | 'notebook', id: string, enabled = true) {
  const demo = useUi((s) => s.demo);
  return useQuery({
    queryKey: linkKeys.of(kind, id),
    enabled: enabled && !demo,
    queryFn: () =>
      api.get<ContextLinkList>(`/${kind === 'thread' ? 'threads' : 'notebooks'}/${enc(id)}/links`),
    retry: false,
  });
}

const refreshLinks = () => queryClient.invalidateQueries({ queryKey: ['context-links'] });

export async function createLink(
  from: { kind: 'thread' | 'notebook'; id: string },
  to: { kind: 'thread' | 'notebook'; id: string },
): Promise<ContextLink | null> {
  try {
    const l = await api.post<ContextLink>(
      `/${from.kind === 'thread' ? 'threads' : 'notebooks'}/${enc(from.id)}/links`,
      {
        to_kind: to.kind,
        to_id: to.id,
      },
    );
    await refreshLinks();
    return l;
  } catch (error) {
    report(error, 'The link');
    return null;
  }
}

export async function removeLink(id: string): Promise<boolean> {
  try {
    await api.del(`/context-links/${enc(id)}`);
    await refreshLinks();
    return true;
  } catch (error) {
    report(error, 'Removing the link');
    return false;
  }
}
