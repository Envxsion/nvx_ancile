/**
 * ------------------------------------------------------------------
 *  Title    |  Another window is sending
 *  Ref      |  docs/api.md (One sender at a time) · thread.busy
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What a thread remembers when Core refused a send
 *           |  because another window (later a phone) is sending in
 *           |  it: the message, and how to send it again as a branch
 *           |  once that window's turn ends.
 *  How      |  One small Zustand store keyed by thread id, imported by
 *           |  the send paths (lib/turns.ts, claudecode/live.ts) and
 *           |  drawn by thread/BusyNotice.tsx. It imports nothing else
 *           |  from the app, so there is no import cycle.
 *  Note     |  In memory only: a reload forgets it, and the text is
 *           |  still in the composer.
 * ------------------------------------------------------------------
 */

import { create } from 'zustand';

export interface BusySend {
  /** Refused, or waiting for the other window's turn to end before sending as a branch. */
  state: 'refused' | 'waiting';
  /** Send the same message again, from the message it answered (a branch if the thread moved on). */
  again: () => Promise<boolean>;
  /** When waiting began (ms), so it gives up after a while. */
  since: number | null;
  /** The turn in the way is paused on a tool approval (Core's context.reason), not another window's. */
  reason?: 'approval';
}

interface BusyStore {
  byThread: Record<string, BusySend>;
  set: (threadId: string, b: BusySend | null) => void;
}

export const useBusyStore = create<BusyStore>((set) => ({
  byThread: {},
  set: (threadId, b) =>
    set((s) => {
      const { [threadId]: _gone, ...rest } = s.byThread;
      return { byThread: b ? { ...rest, [threadId]: b } : rest };
    }),
}));

/** Core said thread.busy: remember how to send again. A message already waiting keeps waiting. */
export function markBusy(
  threadId: string,
  again: () => Promise<boolean>,
  reason?: 'approval',
): void {
  const cur = useBusyStore.getState().byThread[threadId];
  useBusyStore
    .getState()
    .set(
      threadId,
      cur?.state === 'waiting'
        ? { ...cur, again }
        : { state: 'refused', again, since: null, ...(reason && { reason }) },
    );
}

/** The reason Core gave with thread.busy, when it is one the Cockpit has words for. */
export const busyReason = (context: Record<string, unknown> | undefined): 'approval' | undefined =>
  context?.reason === 'approval' ? 'approval' : undefined;

export function clearBusy(threadId: string): void {
  useBusyStore.getState().set(threadId, null);
}

export const isThreadBusy = (code: string | undefined) => code === 'thread.busy';
