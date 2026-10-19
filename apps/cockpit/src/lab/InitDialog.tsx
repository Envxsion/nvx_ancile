/**
 * ------------------------------------------------------------------
 *  Title    |  /init: draft an AGENTS.md
 *  Ref      |  ROADMAP LB2, CH5 · docs/notebooks.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The composer's /init: show a starter AGENTS.md drafted
 *           |  from the repository this thread works in, and write it
 *           |  only when you choose Write AGENTS.md.
 *  How      |  Opens already drafting (POST /lab/init, which writes
 *           |  nothing). The draft, the diff for a file that exists
 *           |  and the write are the same as Settings → Coding lab
 *           |  (lab/initDraft.tsx), so the permission gate applies.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { useEffect } from 'react';
import { useLayer } from '../keys/dispatch';
import { Skeleton } from '../ui/primitives';
import { DraftView, problemText, useInitDraft } from './initDraft';

export function InitDialog({
  repoId,
  repoName,
  onClose,
}: {
  repoId: string;
  repoName: string;
  onClose: () => void;
}) {
  const { draft, save } = useInitDraft();
  useLayer(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft once when the dialog opens
  useEffect(() => draft.mutate(repoId), [repoId]);
  const error = draft.error ?? save.error;
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog" aria-describedby="init-lede">
          <Dialog.Title className="dialog__title">AGENTS.md for {repoName}</Dialog.Title>
          <p id="init-lede" className="dialog__lede">
            The lab reads AGENTS.md from the repository. This is a draft from what the repository shows.
            Nothing is written until you choose Write AGENTS.md, and a file that is already there is never
            replaced.
          </p>
          {draft.isPending ? <Skeleton lines={4} label="Drafting AGENTS.md" /> : null}
          {error ? (
            <p className="setting__desc" role="alert">
              {problemText(error)}
            </p>
          ) : null}
          {draft.data ? <DraftView d={draft.data} save={save} /> : null}
          <div className="dialog__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
