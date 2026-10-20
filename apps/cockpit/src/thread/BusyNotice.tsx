/**
 * ------------------------------------------------------------------
 *  Title    |  Another window is sending
 *  Ref      |  docs/api.md (One sender at a time) · thread/busy-store.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  When Core refused a send because another window is
 *           |  sending in this thread (thread.busy), say so above the
 *           |  composer and offer "Send as a branch": the message goes
 *           |  once that window's turn ends, from the message it was
 *           |  answering, so it never lands after a turn you did not
 *           |  see.
 *  How      |  While waiting, every few seconds: when the thread has
 *           |  no running turn the message is sent, else the thread is
 *           |  read again. Refused again, it keeps waiting, for ten
 *           |  minutes at most.
 *  Note     |  Your text stays in the composer until it is sent.
 * ------------------------------------------------------------------
 */

import { useEffect, useRef } from 'react';
import { ApiCallError, api } from '../lib/api';
import { keys } from '../lib/data';
import { queryClient } from '../lib/query';
import type { PendingApproval, ThreadView } from '../lib/types';
import { notify } from '../state/notify';
import { Icon } from '../ui/Icon';
import { type BusySend, clearBusy, useBusyStore } from './busy-store';
import '../styles/cclive.css';

/** How often the thread is read while a message waits, and for how long at most. */
export const BUSY_POLL_MS = 2_000;
export const BUSY_WAIT_MS = 10 * 60_000;

/** Say no to what this thread is waiting on, then send once its turn ends. */
async function denyAndSend(threadId: string, busy: BusySend) {
  const waiting = (queryClient.getQueryData<PendingApproval[]>(keys.approvals) ?? []).filter(
    (a) => a.threadId === threadId,
  );
  try {
    if (waiting.length)
      await api.post('/approvals/batch', { approval_ids: waiting.map((a) => a.id), decision: 'deny' });
  } catch (error) {
    notify({
      level: 'error',
      title: error instanceof ApiCallError ? error.body.error.title : 'Could not deny the request',
      body:
        error instanceof ApiCallError
          ? error.body.error.hint
          : 'Check that NVX Ancile is running, then try again.',
    });
    return;
  }
  void queryClient.invalidateQueries({ queryKey: keys.approvals });
  useBusyStore.getState().set(threadId, { ...busy, state: 'waiting', since: Date.now() });
}

export function BusyNotice({ threadId, onSent }: { threadId: string; onSent: () => void }) {
  const busy = useBusyStore((s) => s.byThread[threadId]);
  const sending = useRef(false);

  // Waiting: each tick, send when the thread has no running turn, else read it again. One try per
  // tick, so a refusal (the other window started another turn) never turns into a loop.
  useEffect(() => {
    if (busy?.state !== 'waiting') return;
    const tick = () => {
      if (busy.since && Date.now() - busy.since > BUSY_WAIT_MS) {
        useBusyStore.getState().set(threadId, { ...busy, state: 'refused', since: null });
        return;
      }
      const view = queryClient.getQueryData<ThreadView>(keys.thread(threadId));
      if (view?.activeRun || sending.current) {
        void queryClient.invalidateQueries({ queryKey: keys.thread(threadId) });
        return;
      }
      sending.current = true;
      void busy
        .again()
        .then((ok) => {
          if (ok) {
            clearBusy(threadId);
            onSent();
          }
        })
        .finally(() => {
          sending.current = false;
        });
    };
    const t = setInterval(tick, BUSY_POLL_MS);
    return () => clearInterval(t);
  }, [busy, threadId, onSent]);

  if (!busy) return null;
  const waiting = busy.state === 'waiting';
  const approval = busy.reason === 'approval';
  return (
    <div className="cc-notice" data-kind="thread_busy" role={waiting ? 'status' : 'alert'}>
      <Icon name={waiting ? 'clock' : 'branch'} size={14} className="cc-notice__icon" />
      <div className="cc-notice__text">
        {waiting ? (
          <p>
            Your message sends as a branch when {approval ? 'this turn' : "the other window's turn"} ends.
          </p>
        ) : approval ? (
          <p>
            <strong>Waiting for your approval above.</strong> Answer it, deny it and send, or send yours as a
            branch.
          </p>
        ) : (
          <p>
            <strong>Another window is sending in this thread.</strong> Wait for it to finish, or send yours as
            a branch.
          </p>
        )}
      </div>
      <div className="cc-notice__acts">
        {waiting ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => clearBusy(threadId)}>
            Don't send
          </button>
        ) : (
          <>
            {approval ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void denyAndSend(threadId, busy)}
              >
                Deny and send
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() =>
                useBusyStore.getState().set(threadId, { ...busy, state: 'waiting', since: Date.now() })
              }
            >
              Send as a branch
            </button>
          </>
        )}
        {waiting ? null : (
          <button
            type="button"
            className="icon-btn icon-btn--xs"
            aria-label="Dismiss"
            onClick={() => clearBusy(threadId)}
          >
            <Icon name="close" size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
