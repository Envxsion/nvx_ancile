/**
 * ------------------------------------------------------------------
 *  Title    |  Which model answers next
 *  Ref      |  DESIGN.md §7.2, §8.6
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  `m` (or the status bar) changes the model the next
 *           |  message goes to. Inside a thread the choice belongs to
 *           |  that thread; on the home screen it is your default for
 *           |  new threads.
 *  How      |  Thread setting → your default (if it can answer) →
 *           |  the first model that can. Switching inside a thread
 *           |  saves the setting on the thread, so earlier context
 *           |  carries over and the next message uses the new model.
 *           |  When a flow answers the thread, switching asks first:
 *           |  the next message, the thread instead of the flow, or a
 *           |  step inside it (thread/ModelChoice.tsx).
 * ------------------------------------------------------------------
 */

import { useRouterState } from '@tanstack/react-router';
import { helpDone } from '../help/store';
import { notify } from '../state/notify';
import { useUi } from '../state/ui';
import { flowKeys, type ResolvedFlow } from '../thread/flowActions';
import { useModelChoice } from '../thread/ModelChoice';
import { ApiCallError, api } from './api';
import { keys, useModels, useThread } from './data';
import { queryClient } from './query';
import type { ModelView, ThreadView } from './types';

export function useThreadIdFromRoute(): string | undefined {
  return useRouterState({
    select: (s) => (s.location.pathname.startsWith('/t/') ? s.location.pathname.split('/')[2] : undefined),
  });
}

const canAnswer = (m: ModelView | undefined) =>
  !!m && m.chat !== false && (m.status === undefined || m.status === 'ready');

export function useCurrentModel(threadId?: string): ModelView | undefined {
  const models = useModels().data ?? [];
  const thread = useThread(threadId);
  const fallbackId = useUi((s) => s.live.modelId);
  const byId = (id: string | null | undefined) => (id ? models.find((m) => m.id === id) : undefined);
  const fromThread = byId(thread.data?.model);
  if (canAnswer(fromThread)) return fromThread;
  const fromDefault = byId(fallbackId);
  if (canAnswer(fromDefault)) return fromDefault;
  // Never fall into a GPU-node model by accident: asking it wakes (and bills) the node.
  const direct = models.filter((m) => m.via !== 'controller');
  return direct.find((m) => canAnswer(m) && !m.offline) ?? direct.find(canAnswer) ?? models.find(canAnswer);
}

export async function chooseModel(model: ModelView, threadId?: string): Promise<void> {
  if (!canAnswer(model)) {
    notify({
      level: 'warn',
      title: `${model.name} can't answer yet`,
      body:
        model.status === 'needs_key'
          ? 'Add its key in Settings → Models first.'
          : 'Turn it on in Settings → Models first.',
    });
    return;
  }
  // Your default changes only from outside a thread (or in demo mode, where
  // a thread has nowhere to keep its own choice).
  helpDone('switch-model');
  if (!threadId || useUi.getState().demo) {
    useUi.getState().setModel(model.id);
    return;
  }
  // A flow answers this thread: a model here could mean one message, the
  // thread instead of the flow, or a step inside it. Ask (DESIGN.md §16.3).
  const resolved = queryClient.getQueryData<ResolvedFlow>(flowKeys.resolve(threadId));
  if (resolved?.flow) {
    const t = queryClient.getQueryData<ThreadView>(keys.thread(threadId));
    useModelChoice.getState().open({
      threadId,
      model,
      flow: { id: resolved.flow.id, name: resolved.flow.name, from: resolved.from },
      notebookId: t?.notebookId ?? null,
    });
    return;
  }
  // Optimistic: the next send reads the cached thread, so it must change
  // now, not when the PATCH returns. Roll back if Core refuses.
  const before = queryClient.getQueryData<ThreadView>(keys.thread(threadId))?.model ?? null;
  queryClient.setQueryData<ThreadView>(keys.thread(threadId), (t) => (t ? { ...t, model: model.id } : t));
  try {
    await api.patch(`/threads/${threadId}`, { model: model.id });
    notify({
      level: 'success',
      title: `Next message goes to ${model.name}`,
      body: 'Earlier messages in this thread carry over.',
    });
  } catch (error) {
    queryClient.setQueryData<ThreadView>(keys.thread(threadId), (t) => (t ? { ...t, model: before } : t));
    notify({
      level: 'error',
      title: error instanceof ApiCallError ? error.body.error.title : 'The model could not be changed',
      body: error instanceof ApiCallError ? error.body.error.hint : 'Try again.',
    });
  }
}
