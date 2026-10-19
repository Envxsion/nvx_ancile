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
 *           |  Pro steer mode (CH7) adds `steer`: the message was
 *           |  offered to the running answer as a note, which the model
 *           |  reads at its next step. `applied`: the model has it, so
 *           |  the queue lets it go. Still `pending` when the turn ends
 *           |  (the answer finished before a step boundary, or Core
 *           |  restarted): Core is asked once, and a note that missed
 *           |  the turn is sent as an ordinary message. A turn that
 *           |  ends in an error before the note went in keeps the
 *           |  message, held, as without Pro.
 *  Note     |  In memory only, like the Claude Code queue: a reload
 *           |  brings the text back in the composer's own saved draft
 *           |  only if it was never sent, so a queued message that a
 *           |  reload loses was shown as queued, not as sent.
 * ------------------------------------------------------------------
 */

import { create } from 'zustand';
import { api } from '../lib/api';
import type { SteerView } from '../pro/slot';
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
  /** Pro (CH7): the message was offered to the running answer as a note. */
  steer?: SteerView;
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

/** Pro (CH7): where the queued message stands as a note; null puts it back to waiting for the turn to end. */
export function setSteer(threadId: string, steer: SteerView | null): void {
  const q = useQueue.getState().byThread[threadId];
  if (!q) return;
  const { steer: _old, ...rest } = q;
  useQueue.getState().set(threadId, steer ? { ...rest, steer } : rest);
}

/** Only words can go as a note: a message with files, images, a flow or an @-mention waits for its turn. */
export function isPlain(extras: SendExtras): boolean {
  return (
    !extras.images?.length &&
    !extras.attachments?.length &&
    !extras.flowId &&
    !extras.model &&
    !extras.mentions.length
  );
}

/**
 * The turn ended with a note still waiting. Ask Core once whether the model took it: if it did, the
 * message was delivered and leaves the queue; if not (the answer finished before a step boundary, or Core
 * restarted), the note goes back to waiting and the queue sends it as a message.
 */
export async function resolveSteer(threadId: string): Promise<'applied' | 'missed'> {
  const id = useQueue.getState().byThread[threadId]?.steer?.id;
  let state = 'expired';
  if (id) {
    try {
      state = (await api.get<{ state: string }>(`/pro/steer/${encodeURIComponent(id)}`)).state;
    } catch {
      // Not knowing means the message is kept and sent, never dropped.
    }
  }
  if (state === 'applied') {
    dequeue(threadId);
    return 'applied';
  }
  setSteer(threadId, null);
  return 'missed';
}

/**
 * Take the queued message back out. A note still waiting is withdrawn from Core; one the model has
 * already read is not given back. Returns the words to put back in the composer, or null.
 */
export function takeBack(threadId: string): string | null {
  const q = dequeue(threadId);
  if (!q) return null;
  if (q.steer?.id && q.steer.state === 'pending')
    void api.del(`/pro/steer/${encodeURIComponent(q.steer.id)}`).catch(() => undefined);
  return q.steer?.state === 'applied' ? null : q.text;
}

export function hold(threadId: string, why: NonNullable<QueuedSend['why']>): void {
  const q = useQueue.getState().byThread[threadId];
  if (q && !(q.state === 'held' && q.why === why))
    useQueue.getState().set(threadId, { ...q, state: 'held', why });
}

/** What a note to the running answer says about itself. */
export const STEER_WORDS: Record<SteerView['state'], string> = {
  sending: 'Sending it to the model',
  pending: 'Goes to the model at its next step',
  applied: 'The model has your note',
};

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
  q: Pick<QueuedSend, 'state' | 'after' | 'steer'> | undefined,
  now: { busy: boolean; lastId: string | null; lastStatus: string | undefined },
): 'wait' | 'send' | 'hold-error' | 'hold-branch' | 'steered' | 'resolve-steer' {
  if (q?.state !== 'waiting') return 'wait';
  // A note the model has already read is delivered, whatever happens to the turn after.
  if (q.steer?.state === 'applied') return 'steered';
  if (now.busy || now.lastStatus === 'pending' || now.lastStatus === 'streaming') return 'wait';
  if (q.steer) return 'resolve-steer';
  if (now.lastStatus === 'error') return 'hold-error';
  // A reply whose id Core named later still counts as the answer it was queued behind.
  if (q.after && !q.after.startsWith('pending-') && now.lastId !== q.after) return 'hold-branch';
  return 'send';
}
