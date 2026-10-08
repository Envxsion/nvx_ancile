/**
 * ------------------------------------------------------------------
 *  Title    |  Branching
 *  Ref      |  DESIGN.md §8
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Everything the Cockpit does with the conversation as a
 *           |  tree: read it, jump around it, branch, compare, merge,
 *           |  compact, and remove a subtree with a way back.
 *  How      |  Queries for the tree and the context budget, keyed by
 *           |  thread so a settled run refreshes both. Writes go to
 *           |  Core and then invalidate the thread, its tree and its
 *           |  budget; failures become a toast with Core's own words.
 *           |  Topic-shift suggestions from /events are held per
 *           |  thread in a tiny store until used or dismissed.
 * ------------------------------------------------------------------
 */

import type {
  Branch,
  BranchColor,
  BranchTree,
  CompactResult,
  CompareResult,
  DeleteMessageResult,
  MergeResult,
  PathBudget,
  ThreadPath,
} from '@nvx/contracts';
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { helpDone } from '../help/store';
import { tourEvent } from '../help/tours';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { ApiCallError, api } from './api';
import { keys } from './data';
import { toThreadView } from './mappers';
import { queryClient } from './query';
import type { MessageView } from './types';

export const branchKeys = {
  tree: (threadId: string) => ['tree', threadId] as const,
  budget: (threadId: string) => ['budget', threadId] as const,
};

function failed(error: unknown, what: string): void {
  if (error instanceof ApiCallError)
    notify({ level: 'error', title: error.body.error.title, body: error.body.error.hint });
  else
    notify({
      level: 'error',
      title: `${what} didn't reach Core`,
      body: 'Nothing changed. Check that NVX Ancile is running, then try again.',
    });
}

/** After any change to a thread's shape. */
export function refreshThread(threadId: string): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.thread(threadId) }),
    queryClient.invalidateQueries({ queryKey: branchKeys.tree(threadId) }),
    queryClient.invalidateQueries({ queryKey: branchKeys.budget(threadId) }),
    queryClient.invalidateQueries({ queryKey: keys.threads }),
  ]);
}

export function useBranchTree(threadId: string | undefined) {
  const demo = useUi((s) => s.demo);
  return useQuery({
    queryKey: branchKeys.tree(threadId ?? ''),
    queryFn: () => api.get<BranchTree>(`/threads/${threadId}/tree`),
    enabled: !!threadId && !demo,
    staleTime: 5_000,
  });
}

export function useContextBudget(threadId: string | undefined) {
  const demo = useUi((s) => s.demo);
  return useQuery({
    queryKey: branchKeys.budget(threadId ?? ''),
    queryFn: () => api.get<PathBudget>(`/threads/${threadId}/context-budget`),
    enabled: !!threadId && !demo,
    staleTime: 10_000,
  });
}

/** Show the path through `messageId` (Enter in the tree, sibling arrows). */
export async function jumpTo(threadId: string, messageId: string): Promise<boolean> {
  try {
    await api.patch(`/threads/${threadId}`, { active_head_id: messageId });
    await refreshThread(threadId);
    return true;
  } catch (error) {
    failed(error, 'Jumping there');
    return false;
  }
}

/**
 * Branch here: name the point, then open the thread there so the next
 * message starts the branch. The old path stays as it was.
 */
export async function branchHere(
  threadId: string,
  messageId: string,
  opts: { name?: string; createdBy?: 'user' | 'suggestion'; previousHead?: string | null } = {},
): Promise<Branch | null> {
  let b: Branch;
  try {
    b = await api.post<Branch>(`/messages/${messageId}/branch`, {
      ...(opts.name && { name: opts.name }),
      ...(opts.createdBy && { created_by: opts.createdBy }),
    });
  } catch (error) {
    failed(error, 'The branch');
    return null;
  }
  await jumpTo(threadId, b.head_message_id);
  tourEvent('branched');
  helpDone('branch');
  notify({
    level: 'success',
    title: `${b.name} starts here`,
    body: 'Write the next message to continue on this branch. The earlier path is unchanged.',
    undo: () => {
      void (async () => {
        await api.patch(`/branches/${b.id}`, { archived: true }).catch(() => undefined);
        if (opts.previousHead) await jumpTo(threadId, opts.previousHead);
        else await refreshThread(threadId);
      })();
    },
  });
  // The next thing to do is write: put the caret there.
  requestAnimationFrame(() =>
    document.querySelector<HTMLTextAreaElement>('.thread__composer .composer__input')?.focus(),
  );
  return b;
}

/** Name the path you are on, where it is now: nothing moves. */
export async function nameBranch(threadId: string, headId: string, name: string): Promise<Branch | null> {
  try {
    const b = await api.post<Branch>(`/messages/${headId}/branch`, { name, created_by: 'suggestion' });
    await refreshThread(threadId);
    notify({
      level: 'success',
      title: `Named this branch ${b.name}`,
      body: 'It shows in the branch tree, and its name follows the newest message.',
      undo: () => void api.patch(`/branches/${b.id}`, { archived: true }).then(() => refreshThread(threadId)),
    });
    return b;
  } catch (error) {
    failed(error, 'Naming the branch');
    return null;
  }
}

export async function renameBranch(threadId: string, id: string, name: string): Promise<void> {
  try {
    await api.patch(`/branches/${id}`, { name });
    await refreshThread(threadId);
  } catch (error) {
    failed(error, 'Renaming the branch');
  }
}

export async function recolourBranch(threadId: string, id: string, color: BranchColor): Promise<void> {
  try {
    await api.patch(`/branches/${id}`, { color });
    await refreshThread(threadId);
  } catch (error) {
    failed(error, 'Changing the colour');
  }
}

export async function archiveBranch(threadId: string, b: Branch): Promise<void> {
  try {
    await api.patch(`/branches/${b.id}`, { archived: true });
    await refreshThread(threadId);
    notify({
      level: 'info',
      title: `Removed the name ${b.name}`,
      body: 'The messages are still in the tree.',
      undo: () =>
        void api.patch(`/branches/${b.id}`, { archived: false }).then(() => refreshThread(threadId)),
    });
  } catch (error) {
    failed(error, 'Removing the name');
  }
}

export async function compactNow(threadId: string, head?: string | null): Promise<CompactResult | null> {
  try {
    const r = await api.post<CompactResult>(`/threads/${threadId}/compact`, head ? { head } : {});
    await refreshThread(threadId);
    const saved = Math.max(0, r.tokens_before - r.tokens_after);
    notify({
      level: 'success',
      title: r.reused ? 'Already compacted' : 'Compacted',
      body: r.reused
        ? 'An earlier summary already covers this part of the thread, so it is used again.'
        : `${r.replaced_messages} older messages are now a summary, about ${saved.toLocaleString('en-GB')} tokens lighter. The latest turns stay word for word.`,
    });
    return r;
  } catch (error) {
    failed(error, 'Compacting');
    return null;
  }
}

export function compare(threadId: string, a: string, b: string): Promise<CompareResult> {
  return api.post<CompareResult>(`/threads/${threadId}/compare`, { a, b });
}

/** The messages of one path, exactly to its head. */
export async function pathTo(threadId: string, head: string): Promise<MessageView[]> {
  const p = await api.get<ThreadPath>(`/threads/${threadId}/path?head=${encodeURIComponent(head)}&exact=1`);
  return toThreadView(p).messages;
}

export async function merge(req: {
  thread_id: string;
  a: string;
  b: string;
  strategy: 'manual' | 'synthesize';
  picks?: string[];
  title?: string;
}): Promise<MergeResult | null> {
  try {
    const r = await api.post<MergeResult>('/merge', req);
    void queryClient.invalidateQueries({ queryKey: keys.threads });
    return r;
  } catch (error) {
    failed(error, 'Merging');
    return null;
  }
}

/** How many messages a delete would remove (Core says, on a delete without confirmation). */
export async function subtreeSize(messageId: string): Promise<number | null> {
  try {
    await api.del(`/messages/${messageId}`);
    return null; // never happens: an unconfirmed delete always asks
  } catch (error) {
    if (error instanceof ApiCallError && error.body.error.code === 'message.confirm_delete') {
      const n = error.body.error.context?.subtree;
      return typeof n === 'number' ? n : null;
    }
    failed(error, 'Deleting');
    return null;
  }
}

export async function deleteSubtree(threadId: string, messageId: string, count: number): Promise<boolean> {
  try {
    const r = await api.del<DeleteMessageResult>(`/messages/${messageId}?confirm=${count}`);
    await refreshThread(threadId);
    notify({
      level: 'info',
      title: `Removed ${r.deleted} ${r.deleted === 1 ? 'message' : 'messages'}`,
      body: 'Undo is here for 30 seconds.',
      undo: () =>
        void api
          .post(`/messages/${messageId}/restore`, {})
          .then(() => refreshThread(threadId))
          .catch((e) => failed(e, 'Undo')),
    });
    return true;
  } catch (error) {
    failed(error, 'Deleting');
    return false;
  }
}

/* ---- Suggestions (DESIGN.md §8.5) ---------------------------------------- */

export interface BranchSuggestion {
  threadId: string;
  messageId: string;
  title: string;
  message: string;
}

interface SuggestionState {
  byThread: Record<string, BranchSuggestion>;
  offer: (s: BranchSuggestion) => void;
  dismiss: (threadId: string) => void;
}

export const useSuggestions = create<SuggestionState>((set) => ({
  byThread: {},
  offer: (s) => set((st) => ({ byThread: { ...st.byThread, [s.threadId]: s } })),
  dismiss: (threadId) =>
    set((st) => {
      const { [threadId]: _gone, ...rest } = st.byThread;
      return { byThread: rest };
    }),
}));
