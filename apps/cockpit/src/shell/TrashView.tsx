/**
 * ------------------------------------------------------------------
 *  Title    |  Trash view
 *  Ref      |  ROADMAP TC4 · guard rail GR23
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Where deleted threads wait. Restore one, or empty the
 *           |  Trash. Reached from the rail's Archive area and from
 *           |  Settings → Trash.
 *  How      |  Loaded on demand, so the empty shell never pays for
 *           |  it. Each row says when it was deleted and how long is
 *           |  left. Empty Trash asks first and says it cannot be
 *           |  undone; everything else here can.
 * ------------------------------------------------------------------
 */

import { useState } from 'react';
import { relative } from '../lib/format';
import { daysLeft, emptyTrash, restoreThreads, useTrash } from '../lib/trash';
import { ConfirmDialog } from '../ui/Confirm';
import { Icon } from '../ui/Icon';
import { loadError } from '../ui/LoadFailed';
import { Skeleton, Tip } from '../ui/primitives';

export function TrashView({ compact = false }: { compact?: boolean }) {
  const trash = useTrash();
  const [confirm, setConfirm] = useState(false);
  const items = trash.data?.items ?? [];
  const days = trash.data?.retention_days ?? 30;

  if (trash.isPending) return <Skeleton lines={4} label="Loading the Trash" />;
  if (trash.isError && !trash.data) {
    const e = loadError(trash.error, 'The Trash').error;
    return (
      <div className="rail__empty" role="alert">
        <p>{e.title}</p>
        <p>{e.hint}</p>
        <button type="button" className="link-btn" onClick={() => void trash.refetch()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="trash" data-compact={compact || undefined}>
      <p className="trash__note">
        Deleted threads are kept for {days} days, then removed for good. Restore one to put it back exactly
        where it was.
      </p>
      {items.length === 0 ? (
        <p className="rail__empty">The Trash is empty.</p>
      ) : (
        <>
          <ul className="rail__list trash__list" aria-label="Deleted threads">
            {items.map((t) => {
              const left = daysLeft(t);
              return (
                <li key={t.id} className="rail__row trash__row">
                  <div className="rail__item trash__item">
                    <Icon name="trash" size={14} />
                    <span className="trash__text">
                      <span className="rail__label" dir="auto">
                        {t.title}
                      </span>
                      <span className="trash__when">
                        Deleted {relative(t.deleted_at)}. Removed for good in {left}{' '}
                        {left === 1 ? 'day' : 'days'}.
                      </span>
                    </span>
                  </div>
                  <Tip label="Restore">
                    <button
                      type="button"
                      className="rail__more icon-btn icon-btn--xs"
                      aria-label={`Restore ${t.title}`}
                      onClick={() => void restoreThreads([t.id], t.title)}
                    >
                      <Icon name="undo" size={13} />
                    </button>
                  </Tip>
                </li>
              );
            })}
          </ul>
          <div className="trash__foot">
            <button type="button" className="btn btn--ghost" onClick={() => setConfirm(true)}>
              <Icon name="trash" size={13} />
              Empty Trash
            </button>
          </div>
        </>
      )}
      <ConfirmDialog
        copy={
          confirm
            ? {
                title: 'Empty the Trash?',
                body: `This removes ${items.length} ${items.length === 1 ? 'thread' : 'threads'} and their messages for good. They cannot be restored.`,
                action: 'Empty Trash',
                keep: 'Keep them',
              }
            : null
        }
        onConfirm={() => void emptyTrash()}
        onClose={() => setConfirm(false)}
      />
    </div>
  );
}
