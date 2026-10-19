/**
 * ------------------------------------------------------------------
 *  Title    |  Context packs: attach from where you are
 *  Ref      |  ROADMAP CP1 · DESIGN.md §9 · docs/notebooks.md
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Attach or detach a context pack from a thread's or a
 *           |  notebook's own menu, and make a pack from the thread
 *           |  you are in, without going to Admin first.
 *  How      |  One dialog, opened through the editors store
 *           |  (openPackPicker). With Pro and the licence, Pro's own
 *           |  picker (ProUi.parts.PackMenu) fills it; without them
 *           |  the dialog says what packs are, that context links and
 *           |  merge are free, and where to read more. Public: the
 *           |  free build shows the same dialog.
 *  Note     |  TODO(phase-0.1.1): Pro supplies parts.PackMenu in
 *           |  pro/cockpit/index.tsx: the attach/detach list (a pack
 *           |  that would break a scope says so and stays off), "Make a
 *           |  pack from this thread", and a pack deleted while
 *           |  attached dropping off the list. Nothing here reads or
 *           |  writes a pack.
 * ------------------------------------------------------------------
 */

import * as proContract from '@nvx/contracts/pro';
import * as Dialog from '@radix-ui/react-dialog';
import { Link } from '@tanstack/react-router';
import { useLayer } from '../keys/dispatch';
import { Icon } from '../ui/Icon';
import { Skeleton } from '../ui/primitives';
import { useProFeature } from './slot';

export type PackPickerTarget = { kind: 'thread' | 'notebook'; id: string; title: string };

export function PackPicker({
  target,
  onOpenChange,
}: {
  target: PackPickerTarget;
  onOpenChange: (open: boolean) => void;
}) {
  useLayer(true);
  const { ui, unlocked, build, loading, noSeat } = useProFeature('context_packs');
  const Menu = ui?.parts?.PackMenu;
  const words = proContract.PRO_FEATURE_WORDS.context_packs;
  const where = target.kind === 'thread' ? 'this thread' : 'this notebook';
  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog pack-picker" aria-describedby={undefined}>
          <Dialog.Title className="dialog__title">
            <Icon name="archive" size={18} /> Context packs for {target.title || where}
          </Dialog.Title>
          {loading ? (
            <Skeleton lines={3} label="Loading context packs" />
          ) : Menu && unlocked ? (
            <Menu
              target={{ kind: target.kind, id: target.id }}
              title={target.title}
              onClose={() => onOpenChange(false)}
            />
          ) : (
            <div className="pack-picker__locked">
              <p>{words.body}</p>
              <p className="mute">
                {noSeat
                  ? "Pro is on in this workspace, but your account has no Pro seat. Ask the workspace's owner for one."
                  : build === 'pro'
                    ? 'Context packs are part of NVX Ancile Pro: turn Pro on with your key to attach them here.'
                    : 'Context packs are part of NVX Ancile Pro, which this build does not include. Context links and notebook merge are free.'}
              </p>
              <div className="dialog__actions">
                <Dialog.Close asChild>
                  <button type="button" className="btn btn--ghost">
                    Close
                  </button>
                </Dialog.Close>
                <Link
                  to="/admin/$section"
                  params={{ section: 'context-packs' }}
                  className="btn btn--primary"
                  onClick={() => onOpenChange(false)}
                >
                  See what packs do
                </Link>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
