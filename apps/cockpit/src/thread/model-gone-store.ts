/**
 * ------------------------------------------------------------------
 *  Title    |  A model that is gone
 *  Ref      |  docs/errors.md (model.gone)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What a thread remembers when Core refused a send, edit
 *           |  or regenerate because the model it named was removed or
 *           |  renamed: which model, the one Core suggests instead, and
 *           |  how to send again with the one the person picks.
 *  How      |  One small Zustand store keyed by thread id, set by the
 *           |  send paths (lib/turns.ts) and drawn by
 *           |  thread/ModelGoneNotice.tsx. It imports nothing else from
 *           |  the app, so there is no import cycle.
 *  Note     |  In memory only: a reload forgets it.
 * ------------------------------------------------------------------
 */

import { create } from 'zustand';

export interface ModelGone {
  /** The model that is no longer in the list. */
  modelId: string;
  /** Core's suggestion: the thread's model, else the default route's first. */
  suggested: string | null;
  /** Send the same thing again with the model picked. */
  again: (model: string) => Promise<boolean>;
  /** Own words, when the model is not gone but could not answer (model.pinned_unavailable). */
  words?: { heading: string; body: string };
}

interface ModelGoneStore {
  byThread: Record<string, ModelGone>;
  set: (threadId: string, g: ModelGone | null) => void;
}

export const useModelGoneStore = create<ModelGoneStore>((set) => ({
  byThread: {},
  set: (threadId, g) =>
    set((s) => {
      const { [threadId]: _gone, ...rest } = s.byThread;
      return { byThread: g ? { ...rest, [threadId]: g } : rest };
    }),
}));

export const isModelGone = (code: string | undefined) => code === 'model.gone';

/** Read Core's model.gone error context into what the notice needs. */
export function markModelGone(
  threadId: string,
  context: Record<string, unknown> | undefined,
  again: (model: string) => Promise<boolean>,
): void {
  const modelId = typeof context?.model_id === 'string' ? context.model_id : 'That model';
  const suggested = typeof context?.suggested_model === 'string' ? context.suggested_model : null;
  useModelGoneStore.getState().set(threadId, { modelId, suggested, again });
}

export function clearModelGone(threadId: string): void {
  useModelGoneStore.getState().set(threadId, null);
}
