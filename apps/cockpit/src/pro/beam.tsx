/**
 * ------------------------------------------------------------------
 *  Title    |  Beam: where it opens
 *  Ref      |  DESIGN.md §9 (Pro) · pro/slot.tsx
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  "Ask several models at once" opens here, from the
 *           |  composer (/beam) or the palette. With Pro and the
 *           |  licence, Pro's own Beam panel fills the dialog; without
 *           |  them, the dialog explains what Beam is instead.
 *  How      |  A small store says where the question goes (thread,
 *           |  notebook, the message it replies to) and its text so
 *           |  far; BeamHost, mounted once in the shell, renders it.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { create } from 'zustand';
import { useLayer } from '../keys/dispatch';
import { Skeleton } from '../ui/primitives';
import { ProUpsell, useProFeature } from './slot';

interface BeamTarget {
  threadId: string | null;
  notebookId: string | null;
  parentId: string | null | undefined;
  text: string;
}

interface BeamState {
  open: BeamTarget | null;
  show: (t: Partial<BeamTarget>) => void;
  close: () => void;
}

export const useBeam = create<BeamState>((set) => ({
  open: null,
  show: (t) =>
    set({
      open: {
        threadId: t.threadId ?? null,
        notebookId: t.notebookId ?? null,
        parentId: t.parentId,
        text: t.text ?? '',
      },
    }),
  close: () => set({ open: null }),
}));

export const openBeam = (t: Partial<BeamTarget> = {}) => useBeam.getState().show(t);

export function BeamHost() {
  const target = useBeam((s) => s.open);
  const close = useBeam((s) => s.close);
  const { ui, unlocked, build, loading } = useProFeature('beam');
  useLayer(!!target);
  const Panel = ui?.parts?.BeamDialog;
  const panel = !!target && !loading && !!Panel && unlocked;
  return (
    <Dialog.Root open={!!target} onOpenChange={(o) => (o ? undefined : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog beam-host" aria-describedby={undefined}>
          {/* The title belongs to the dialog, so Pro's panel never needs Radix itself. */}
          {/* The card below names the feature itself, so the title is for screen readers then. */}
          <Dialog.Title className={panel || loading ? 'dialog__title' : 'sr-only'}>
            Ask several models at once
          </Dialog.Title>
          {!target ? null : loading ? (
            <Skeleton lines={4} label="Loading Beam" />
          ) : panel && Panel ? (
            <Panel {...target} onClose={close} />
          ) : (
            <ProUpsell feature="beam" build={build} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
