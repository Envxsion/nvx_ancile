/**
 * ------------------------------------------------------------------
 *  Title    |  Notification centre
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Every notice from the last 90 days, newest first, kept
 *           |  by Core so it survives a reload. `g i` opens it; opening
 *           |  marks what you can see as read, here and on Core.
 * ------------------------------------------------------------------
 */

import * as Dialog from '@radix-ui/react-dialog';
import { useEffect } from 'react';
import { useLayer } from '../keys/dispatch';
import { useNotificationHistory } from '../lib/notifications';
import { useNotify } from '../state/notify';
import { useUi } from '../state/ui';
import { Icon } from '../ui/Icon';
import { EmptyState } from '../ui/primitives';

/** 14:02 today; 3 Oct, 14:02 before that. */
function when(ms: number): string {
  const d = new Date(ms);
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? t
    : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${t}`;
}

/** Back-to-back notices that say the same thing read as one, with a count. */
function groupRepeats<T extends { title: string; body?: string | null }>(
  list: T[],
): { n: T; times: number }[] {
  const out: { n: T; times: number }[] = [];
  for (const n of list) {
    const last = out.at(-1);
    if (last && last.n.title === n.title && (last.n.body ?? '') === (n.body ?? '')) last.times += 1;
    else out.push({ n, times: 1 });
  }
  return out;
}

export function Center() {
  const open = useUi((s) => s.centerOpen);
  const setOpen = useUi((s) => s.setCenter);
  const history = useNotify((s) => s.history);
  const markAllRead = useNotify((s) => s.markAllRead);
  const unread = useNotify((s) => s.history.some((h) => !h.read));
  const { more, loadMore, loading } = useNotificationHistory();
  useLayer(open);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(markAllRead, 600);
    return () => clearTimeout(t);
  }, [open, markAllRead]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim scrim--light" />
        <Dialog.Content className="center" aria-describedby={undefined}>
          <header className="center__head">
            <Dialog.Title className="center__title">Notifications</Dialog.Title>
            {unread ? (
              <button type="button" className="link-btn" onClick={markAllRead}>
                Mark all read
              </button>
            ) : null}
            <Dialog.Close className="icon-btn icon-btn--sm" aria-label="Close">
              <Icon name="close" size={14} />
            </Dialog.Close>
          </header>
          {history.length === 0 ? (
            <EmptyState
              icon="bell"
              title="You're up to date"
              body="Background work, fallbacks and finished jobs are listed here as they happen."
            />
          ) : (
            <ol className="center__list" data-scrollable>
              {groupRepeats(history).map(({ n, times }) => (
                <li
                  key={n.id}
                  className="center__item"
                  data-level={n.level}
                  data-unread={!n.read || undefined}
                >
                  <span className="center__dot" aria-hidden="true" />
                  <div className="center__item-body">
                    <p className="center__item-title">
                      {n.title}
                      {times > 1 ? (
                        <span className="center__times mute" data-num>
                          {' '}
                          {times} times
                        </span>
                      ) : null}
                    </p>
                    {n.body ? <p className="mute">{n.body}</p> : null}
                    {n.action ? (
                      <button
                        type="button"
                        className="link-btn center__action"
                        onClick={() => {
                          n.action?.run();
                          setOpen(false);
                        }}
                      >
                        {n.action.label}
                      </button>
                    ) : null}
                  </div>
                  <time className="mute" dateTime={new Date(n.at).toISOString()}>
                    {when(n.at)}
                  </time>
                </li>
              ))}
              {more ? (
                <li className="center__more">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={loading}
                    onClick={() => void loadMore()}
                  >
                    {loading ? 'Loading' : 'Show older'}
                  </button>
                </li>
              ) : null}
            </ol>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
