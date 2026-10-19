/**
 * ------------------------------------------------------------------
 *  Title    |  The message waiting behind a running answer
 *  Ref      |  ROADMAP.md CH7 · claudecode/store.ts (the same idea)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  In a model thread you can write and send the next
 *           |  message while an answer is still streaming. It waits
 *           |  here, visible above the composer, and goes when the
 *           |  turn ends, in the thread it was written in.
 *  How      |  One small Zustand store keyed by thread id. Free keeps
 *           |  one message in the queue. ThreadView sends it when the
 *           |  turn ends (`ready`); when the turn ended in an error, or
 *           |  you moved to another branch, it is `held` and says why,
 *           |  and stays until you send it or remove it.
 *  Note     |  In memory only, like the Claude Code queue: a reload
 *           |  brings the text back in the composer's own saved draft
 *           |  only if it was never sent, so a queued message that a
 *           |  reload loses was shown as queued, not as sent.
 *           |  TODO(phase-0.1.1): Pro steer mode, which injects the
 *           |  message into a running tool loop instead of waiting.
 * ------------------------------------------------------------------
 */

import { create } from 'zustand';
import type { SendExtras } from './Composer';

export interface QueuedSend {
  text: string;
  extras: SendExtras;
  /** The answer that was being written when this was queued: the message it replies to. */
  after: string | null;
  /** waiting: sends when the turn ends. held: it will not send by itself. */
  state: 'waiting' | 'held';
  /** Why it is held. */
  why?: 'error' | 'branch' | 'failed';
}

interface QueueStore {
  byThread: Record<string, QueuedSend>;
  set: (threadId: string, q: QueuedSend | null) => void;
}

export const useQueue = create<QueueStore>((set) => ({
  byThread: {},
  set: (threadId, q) =>
    set((s) => {
      const { [threadId]: _gone, ...rest } = s.byThread;
      return { byThread: q ? { ...rest, [threadId]: q } : rest };
    }),
}));

/** Queue a message; false when one is already waiting (Free keeps one). */
export function enqueue(threadId: string, q: Omit<QueuedSend, 'state' | 'why'>): boolean {
  if (useQueue.getState().byThread[threadId]) return false;
  useQueue.getState().set(threadId, { ...q, state: 'waiting' });
  return true;
}

/** Take the queued message out (it is sent, or removed). */
export function dequeue(threadId: string): QueuedSend | null {
  const q = useQueue.getState().byThread[threadId] ?? null;
  if (q) useQueue.getState().set(threadId, null);
  return q;
}

export function hold(threadId: string, why: NonNullable<QueuedSend['why']>): void {
  const q = useQueue.getState().byThread[threadId];
  if (q && !(q.state === 'held' && q.why === why))
    useQueue.getState().set(threadId, { ...q, state: 'held', why });
}

/** What a held message says about itself. */
export const HELD_WORDS: Record<NonNullable<QueuedSend['why']>, string> = {
  error: 'The answer stopped with an error. Your message is still here.',
  branch: 'You moved to another branch. Your message is still here.',
  failed: 'It did not send. Your message is still here.',
};

/**
 * What to do with a waiting message, given where the thread is now: keep waiting while the answer
 * is being written, send it when the turn has ended, or hold it (the answer ended in an error, or
 * you are on another branch than the one it was written in).
 */
export function queueStep(
  q: Pick<QueuedSend, 'state' | 'after'> | undefined,
  now: { busy: boolean; lastId: string | null; lastStatus: string | undefined },
): 'wait' | 'send' | 'hold-error' | 'hold-branch' {
  if (q?.state !== 'waiting') return 'wait';
  if (now.busy || now.lastStatus === 'pending' || now.lastStatus === 'streaming') return 'wait';
  if (now.lastStatus === 'error') return 'hold-error';
  // A reply whose id Core named later still counts as the answer it was queued behind.
  if (q.after && !q.after.startsWith('pending-') && now.lastId !== q.after) return 'hold-branch';
  return 'send';
}
