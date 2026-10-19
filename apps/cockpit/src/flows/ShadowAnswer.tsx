/**
 * ------------------------------------------------------------------
 *  Title    |  Shadow answer link
 *  Ref      |  ROADMAP FL1 · DESIGN.md §16 (Flow lab, Pro)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  When a shadow flow answered the same question off the
 *           |  record, say so where the answer's flow is shown, and
 *           |  open what the shadow flow wrote. When it failed, say
 *           |  that too, and that the live answer is untouched.
 *  How      |  GET /pro/messages/:id/shadow, asked only where the licence
 *           |  unlocks the Flow lab (the free build never asks). A 404
 *           |  is "none ran" and shows nothing. The answer opens in a
 *           |  dialog beside nothing else: it never replaces the live
 *           |  one.
 *  Note     |  Pro serves GET /pro/messages/:id/shadow from its saved
 *           |  shadow results (FL1).
 * ------------------------------------------------------------------
 */

import type { ShadowOutcome } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Term } from '../help/Term';
import { ApiCallError, api } from '../lib/api';
import { Icon } from '../ui/Icon';

interface Licence {
  features: { id: string; unlocked: boolean }[];
}

/** Whether the Flow lab is unlocked here. Same query as the edition mark, so it costs nothing extra. */
export function useFlowLabOn(): boolean {
  const q = useQuery({
    queryKey: ['license', 'details'],
    queryFn: () => api.get<Licence>('/license/details'),
    staleTime: 30_000,
  });
  return q.data?.features?.find((f) => f.id === 'flow_lab')?.unlocked ?? false;
}

export function useShadow(messageId: string) {
  const on = useFlowLabOn();
  return useQuery({
    queryKey: ['shadow', messageId],
    enabled: on,
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<ShadowOutcome | null> => {
      try {
        return await api.get<ShadowOutcome>(`/pro/messages/${messageId}/shadow`);
      } catch (e) {
        if (e instanceof ApiCallError && (e.status === 404 || e.status === 402)) return null;
        throw e;
      }
    },
  });
}

export function ShadowAnswerLink({ messageId }: { messageId: string }) {
  const q = useShadow(messageId);
  const [open, setOpen] = useState(false);
  const s = q.data;
  if (!s) return null;
  if (s.status === 'failed')
    return (
      <span className="shadow-note mute" title={s.error ?? undefined}>
        <Icon name="warn" size={11} />
        Shadow flow failed. This answer is not affected.
      </span>
    );
  return (
    <>
      <button type="button" className="link-btn" onClick={() => setOpen(true)}>
        Shadow answer
      </button>
      {open ? (
        <Dialog.Root open onOpenChange={setOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="scrim" />
            <Dialog.Content className="dialog" aria-describedby="shadow-lede">
              <Dialog.Title className="dialog__title">
                <Icon name="branch" size={18} /> Shadow answer
              </Dialog.Title>
              <p id="shadow-lede" className="mute">
                {s.flow_name ?? <Term id="shadow">A shadow flow</Term>} answered the same question off the
                record. Nothing here changed your thread.
              </p>
              <div className="shadow-answer" dir="auto">
                {s.answer}
              </div>
              <div className="dialog__actions">
                <Dialog.Close className="btn btn--primary" type="button">
                  Done
                </Dialog.Close>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </>
  );
}
