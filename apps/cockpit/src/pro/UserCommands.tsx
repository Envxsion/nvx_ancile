/**
 * ------------------------------------------------------------------
 *  Title    |  Your own commands: where they open
 *  Ref      |  ROADMAP KP1 · pro/slot.tsx · palette/userCommands.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The palette lists commands of your own (a chain of its
 *           |  actions, or a flow run on the selection or thread) and
 *           |  one entry, "Your commands", that opens a dialog to
 *           |  create, edit and delete them. With Pro and the licence
 *           |  (flow_lab) Pro's own editor fills the dialog; without
 *           |  them it says what the commands are and what unlocks
 *           |  them. Nothing breaks and nothing is hidden when locked.
 *  How      |  useUserCommands reads the list through Pro's part
 *           |  (never when locked). UserCommandsHost is mounted by the
 *           |  palette and opened through a small store. Running a
 *           |  command is the palette's (palette/userCommands.ts).
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { useLayer } from '../keys/dispatch';
import { queryClient } from '../lib/query';
import { Icon } from '../ui/Icon';
import { LoadFailed } from '../ui/LoadFailed';
import { Skeleton } from '../ui/primitives';
import { type CommandEditorProps, ProUpsell, type UserCommandView, useProFeature } from './slot';

const KEY = ['pro', 'commands'] as const;

export const useCommandsDialog = create<{ open: boolean; show: () => void; hide: () => void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

export const openCommandsDialog = () => useCommandsDialog.getState().show();

/** Your commands, once the licence unlocks them and Pro's part is there; nothing otherwise. */
export function useUserCommands(enabled: boolean) {
  const { ui, unlocked, build, loading, noSeat } = useProFeature('flow_lab');
  const list = ui?.parts?.userCommands;
  const usable = unlocked && !!list && !!ui?.parts?.CommandEditor;
  const q = useQuery({
    queryKey: KEY,
    enabled: enabled && usable,
    staleTime: 15_000,
    queryFn: () => (list as NonNullable<typeof list>).list(),
  });
  return {
    commands: (usable ? q.data : undefined) ?? ([] as UserCommandView[]),
    usable,
    build,
    noSeat,
    loading: loading || (usable && q.isLoading),
    error: usable && q.isError ? q.error : null,
    refetch: () => q.refetch(),
  };
}

type HostProps = Omit<CommandEditorProps, 'commands' | 'onChanged' | 'onClose'>;

export function UserCommandsHost(props: HostProps) {
  const open = useCommandsDialog((s) => s.open);
  const hide = useCommandsDialog((s) => s.hide);
  if (!open) return null;
  return <CommandsDialog {...props} onClose={hide} />;
}

function CommandsDialog({ onClose, ...props }: HostProps & { onClose: () => void }) {
  useLayer(true);
  const cmds = useUserCommands(true);
  const { ui } = useProFeature('flow_lab');
  const Editor = ui?.parts?.CommandEditor;
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog pack-picker" aria-describedby={undefined}>
          <Dialog.Title className="dialog__title">
            <Icon name="command" size={18} /> Your commands
          </Dialog.Title>
          {cmds.loading ? (
            <Skeleton lines={3} label="Loading your commands" />
          ) : cmds.error ? (
            <LoadFailed error={cmds.error} what="Your commands" onRetry={() => void cmds.refetch()} />
          ) : Editor && cmds.usable ? (
            <Editor
              {...props}
              commands={cmds.commands}
              onChanged={() => void queryClient.invalidateQueries({ queryKey: KEY })}
              onClose={onClose}
            />
          ) : (
            <div className="pack-picker__locked">
              <p>
                Name a chain of palette actions, or a flow to run on the selection or the thread, and find it
                by name in the palette.
              </p>
              <ProUpsell feature="flow_lab" build={cmds.build} />
              <div className="dialog__actions">
                <Dialog.Close asChild>
                  <button type="button" className="btn btn--ghost">
                    Close
                  </button>
                </Dialog.Close>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
