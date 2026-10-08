/**
 * ------------------------------------------------------------------
 *  Title    |  Branch layer
 *  Ref      |  DESIGN.md §8
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Everything about branches that floats over a thread:
 *           |  the full-screen tree (g b), compare, merge, the delete
 *           |  confirmation and renaming a branch. Mounted once by the
 *           |  thread view.
 *  How      |  Each surface reads its own field of the branch layer
 *           |  store. The full-screen tree is a Radix dialog; its keys
 *           |  live on the tree itself, so they keep working there.
 * ------------------------------------------------------------------
 */

import { BranchColor } from '@nvx/contracts';
import * as Dialog from '@radix-ui/react-dialog';
import { type CSSProperties, useEffect, useState } from 'react';
import { useLayer } from '../keys/dispatch';
import { deleteSubtree, recolourBranch, renameBranch, useBranchTree } from '../lib/branching';
import { hueVar } from '../lib/format';
import { Icon } from '../ui/Icon';
import { Kbd } from '../ui/primitives';
import { CompareDialog } from './Compare';
import { LazyBranchTree as BranchTree } from './LazyTree';
import { MergeDialog } from './MergeDialog';
import { useBranchLayer } from './store';

function TreeFull({ threadId }: { threadId: string }) {
  const open = useBranchLayer((s) => s.full);
  const setFull = useBranchLayer((s) => s.setFull);
  const tree = useBranchTree(open ? threadId : undefined);
  useLayer(open);
  const forks = tree.data?.nodes.filter((n) => n.children > 1).length ?? 0;
  return (
    <Dialog.Root open={open} onOpenChange={setFull}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content
          className="tree-full m-glass-thick"
          aria-describedby="tree-full-help"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            requestAnimationFrame(() => document.querySelector<HTMLElement>('.tree-full .btree')?.focus());
          }}
        >
          <header className="tree-full__head">
            <Dialog.Title className="tree-full__title">
              <Icon name="tree" size={16} /> Branch tree
            </Dialog.Title>
            {tree.data ? (
              <span className="mute" data-num>
                {tree.data.total} messages · {forks} {forks === 1 ? 'fork' : 'forks'} ·{' '}
                {tree.data.branches.length} named
              </span>
            ) : null}
            <span className="tree-full__spacer" />
            <p id="tree-full-help" className="tree-full__keys mute">
              <Kbd keys="j" /> <Kbd keys="k" /> walk <Kbd keys="h" /> <Kbd keys="l" /> versions{' '}
              <Kbd keys="enter" /> jump <Kbd keys="c" /> compare
            </p>
            <Dialog.Close className="icon-btn" aria-label="Close the tree">
              <Icon name="close" size={14} />
            </Dialog.Close>
          </header>
          <div className="tree-full__canvas">
            {open ? <BranchTree threadId={threadId} variant="full" /> : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DeleteDialog() {
  const del = useBranchLayer((s) => s.del);
  const setDel = useBranchLayer((s) => s.setDel);
  const [busy, setBusy] = useState(false);
  useLayer(!!del);
  return (
    <Dialog.Root open={!!del} onOpenChange={(o) => !o && setDel(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog" aria-describedby="del-desc">
          <Dialog.Title className="dialog__title">
            Remove {del?.count} {del?.count === 1 ? 'message' : 'messages'}?
          </Dialog.Title>
          <p id="del-desc" className="dialog__lede">
            This message and everything that grew from it leave the thread, on every branch through it. You
            can undo for 30 seconds.
          </p>
          <div className="dialog__actions">
            <Dialog.Close className="btn btn--ghost">Keep them</Dialog.Close>
            <button
              type="button"
              className="btn btn--danger"
              data-busy={busy || undefined}
              onClick={async () => {
                if (!del || busy) return;
                setBusy(true);
                await deleteSubtree(del.threadId, del.messageId, del.count);
                setBusy(false);
                setDel(null);
              }}
            >
              <Icon name="trash" size={14} />
              Remove {del?.count}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RenameDialog() {
  const rename = useBranchLayer((s) => s.rename);
  const setRename = useBranchLayer((s) => s.setRename);
  const [name, setName] = useState('');
  const [color, setColor] = useState<BranchColor>('azure');
  useLayer(!!rename);
  useEffect(() => {
    if (rename) {
      setName(rename.branch.name);
      setColor(rename.branch.color);
    }
  }, [rename]);
  const save = async () => {
    if (!rename) return;
    const n = name.trim();
    if (n && n !== rename.branch.name) await renameBranch(rename.threadId, rename.branch.id, n);
    if (color !== rename.branch.color) await recolourBranch(rename.threadId, rename.branch.id, color);
    setRename(null);
  };
  return (
    <Dialog.Root open={!!rename} onOpenChange={(o) => !o && setRename(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog" aria-describedby={undefined}>
          <Dialog.Title className="dialog__title">Name this branch</Dialog.Title>
          <form
            className="rename-branch"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="field">
              <span>Name</span>
              <input
                className="input"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                // biome-ignore lint/a11y/noAutofocus: the person asked to rename
                autoFocus
              />
            </label>
            <div className="new-nb__hues" role="radiogroup" aria-label="Colour">
              {BranchColor.options.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={c === color}
                  aria-label={c}
                  className="new-nb__hue"
                  style={{ '--hue': hueVar(c) } as CSSProperties}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
            <div className="dialog__actions">
              <Dialog.Close className="btn btn--ghost" type="button">
                Cancel
              </Dialog.Close>
              <button type="submit" className="btn btn--primary">
                Save
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function BranchLayer({ threadId }: { threadId: string }) {
  return (
    <>
      <TreeFull threadId={threadId} />
      <CompareDialog />
      <MergeDialog />
      <DeleteDialog />
      <RenameDialog />
    </>
  );
}
