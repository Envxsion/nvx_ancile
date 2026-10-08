/**
 * ------------------------------------------------------------------
 *  Title    |  Sending, regenerating, editing, stopping
 *  Ref      |  DESIGN.md §8
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The four things you do to a conversation, each ending
 *           |  the same way: your message and an empty reply appear in
 *           |  the thread at once, and the reply fills in from its run.
 *  How      |  Core answers 202 with the ids it created; those rows go
 *           |  straight into the cached thread (no flash of a refetch)
 *           |  and attachRun() streams the reply. A failure leaves the
 *           |  draft where it was and says what to do.
 * ------------------------------------------------------------------
 */

import type { Part } from '@nvx/contracts';
import { helpDone } from '../help/store';
import { notify } from '../state/notify';
import { ApiCallError, api } from './api';
import { keys } from './data';
import { queryClient } from './query';
import { attachRun } from './run';
import type { MessageView, ThreadView } from './types';

interface Started {
  run_id: string;
  user_message_id: string;
  assistant_message_id: string;
}

function reportFailure(error: unknown, what: string): void {
  if (error instanceof ApiCallError)
    notify({ level: 'error', title: error.body.error.title, body: error.body.error.hint });
  else
    notify({
      level: 'error',
      title: `${what} didn't reach Core`,
      body: 'Check that NVX Ancile is running, then try again. Your text is kept.',
    });
}

/** Put the new rows into the cached path: drop anything after `parentId`, then append. */
function placeTurn(threadId: string, parentId: string | null, rows: MessageView[]): void {
  queryClient.setQueryData<ThreadView>(keys.thread(threadId), (t) => {
    if (!t) return t;
    const cut = parentId ? t.messages.findIndex((m) => m.id === parentId) : -1;
    const kept = parentId ? (cut >= 0 ? t.messages.slice(0, cut + 1) : t.messages) : [];
    return { ...t, messages: [...kept, ...rows], activeRun: null };
  });
}

const now = () => new Date().toISOString();

function assistantRow(s: Started, parentId: string, modelId: string | null): MessageView {
  return {
    id: s.assistant_message_id,
    parentId,
    role: 'assistant',
    blocks: [],
    parts: [],
    modelId,
    createdAt: now(),
    status: 'streaming',
    runId: s.run_id,
  };
}

export async function createThread(
  model?: string | null,
  notebookId?: string | null,
): Promise<string | null> {
  try {
    const t = await api.post<{ id: string }>('/threads', {
      ...(model && { model }),
      ...(notebookId && { notebook_id: notebookId }),
    });
    void queryClient.invalidateQueries({ queryKey: keys.threads });
    return t.id;
  } catch (error) {
    reportFailure(error, 'The new thread');
    return null;
  }
}

/** Send a message as a reply to `parentId`. Resolves false when nothing was sent. */
export async function sendMessage(opts: {
  threadId: string;
  parentId: string | null;
  text: string;
  /** A model chosen for this message: it answers instead of any flow. */
  model?: string | null;
  /** Your default for plain chat: used only when no flow or thread model decides. */
  defaultModel?: string | null;
  /** @-mentions: sources narrow the search, a notebook grounds a loose thread. */
  mentions?: { kind: 'source' | 'notebook'; id: string }[];
  /** Answer through this flow (`@flow`), for this one message. */
  flowId?: string | null;
}): Promise<boolean> {
  const parts: Part[] = [{ type: 'text', text: opts.text }];
  let s: Started;
  try {
    s = await api.post<Started>(`/threads/${opts.threadId}/messages`, {
      parent_id: opts.parentId,
      parts,
      ...(opts.model && { model: opts.model }),
      ...(opts.defaultModel && !opts.model && { default_model: opts.defaultModel }),
      ...(opts.mentions?.length && { mentions: opts.mentions }),
      ...(opts.flowId && { flow_id: opts.flowId }),
    });
  } catch (error) {
    reportFailure(error, 'Your message');
    return false;
  }
  placeTurn(opts.threadId, opts.parentId, [
    {
      id: s.user_message_id,
      parentId: opts.parentId,
      role: 'user',
      blocks: [],
      parts,
      modelId: null,
      createdAt: now(),
      status: 'complete',
    },
    assistantRow(s, s.user_message_id, opts.model ?? opts.defaultModel ?? null),
  ]);
  attachRun({ runId: s.run_id, threadId: opts.threadId, messageId: s.assistant_message_id });
  void queryClient.invalidateQueries({ queryKey: keys.threads });
  helpDone('first-thread');
  return true;
}

export async function regenerate(threadId: string, m: MessageView, model?: string): Promise<void> {
  if (!m.parentId) return;
  try {
    const s = await api.post<Started>(`/messages/${m.id}/regenerate`, model ? { model } : {});
    placeTurn(threadId, m.parentId, [assistantRow(s, m.parentId, model ?? null)]);
    attachRun({ runId: s.run_id, threadId, messageId: s.assistant_message_id });
    helpDone('branch');
  } catch (error) {
    reportFailure(error, 'Regenerate');
  }
}

export async function editMessage(threadId: string, m: MessageView, text: string): Promise<boolean> {
  const parts: Part[] = [{ type: 'text', text }];
  try {
    const s = await api.post<Started>(`/messages/${m.id}/edit`, { parts });
    placeTurn(threadId, m.parentId, [
      {
        id: s.user_message_id,
        parentId: m.parentId,
        role: 'user',
        blocks: [],
        parts,
        modelId: null,
        createdAt: now(),
        status: 'complete',
      },
      assistantRow(s, s.user_message_id, null),
    ]);
    attachRun({ runId: s.run_id, threadId, messageId: s.assistant_message_id });
    helpDone('branch');
    return true;
  } catch (error) {
    reportFailure(error, 'The edit');
    return false;
  }
}

/** Hand one of your messages to the lab: the engine works on it in this thread's lab folder. */
export async function runInLab(threadId: string, m: MessageView): Promise<void> {
  try {
    const s = await api.post<Started>(`/messages/${m.id}/lab`, {});
    placeTurn(threadId, m.id, [assistantRow(s, m.id, null)]);
    attachRun({ runId: s.run_id, threadId, messageId: s.assistant_message_id });
  } catch (error) {
    reportFailure(error, 'Starting the lab');
  }
}

export interface LabChange {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'deleted' | 'modified';
}

export function labChanges(runId: string): Promise<{ items: LabChange[]; undo: boolean }> {
  return api.get(`/runs/${runId}/diff`);
}

export async function undoLab(runId: string): Promise<boolean> {
  try {
    const r = await api.post<{ files: number }>(`/runs/${runId}/undo`);
    notify({
      level: 'success',
      title: 'Undone',
      body: `The lab folder is back as it was before this run (${r.files} files).`,
    });
    return true;
  } catch (error) {
    reportFailure(error, 'Undo');
    return false;
  }
}

export async function stopMessage(messageId: string): Promise<void> {
  try {
    await api.post(`/messages/${messageId}/stop`);
  } catch (error) {
    reportFailure(error, 'Stop');
  }
}

/** Show another version (‹ 2 / 3 ›) by moving the thread's head to it. */
export async function showVersion(threadId: string, messageId: string): Promise<void> {
  try {
    await api.patch(`/threads/${threadId}`, { active_head_id: messageId });
    await queryClient.invalidateQueries({ queryKey: keys.thread(threadId) });
  } catch (error) {
    reportFailure(error, 'Switching version');
  }
}
