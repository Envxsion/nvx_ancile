/**
 * ------------------------------------------------------------------
 *  Title    |  Confirm
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One confirm for every destructive action: it names
 *           |  what will happen, and the button says it again.
 *  How      |  A Radix dialog driven by a `pending` value: null is
 *           |  closed. The caller passes the copy and the action;
 *           |  confirming runs it and closes.
 *  Note     |  Pair it with an undo toast (notify({ undo })) where
 *           |  the data allows the action to be taken back.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { useLayer } from '../keys/dispatch';

export interface ConfirmCopy {
  /** A question naming the thing: "Remove repo ancile?" */
  title: string;
  /** What happens, and what does not. */
  body: ReactNode;
  /** Says what happens: "Remove repo", "Revoke grant". */
  action: string;
  /** The way out. Defaults to "Cancel". */
  keep?: string;
}

export function ConfirmDialog({
  copy,
  onConfirm,
  onClose,
}: {
  copy: ConfirmCopy | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const open = Boolean(copy);
  useLayer(open);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog m-glass-thick" aria-describedby="confirm-desc">
          <Dialog.Title className="dialog__title">{copy?.title}</Dialog.Title>
          <div id="confirm-desc" className="dialog__lede">
            {copy?.body}
          </div>
          <div className="dialog__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {copy?.keep ?? 'Cancel'}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                onConfirm();
                onClose();
              }}
            >
              {copy?.action}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
