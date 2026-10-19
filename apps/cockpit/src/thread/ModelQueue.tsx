/**
 * ------------------------------------------------------------------
 *  Title    |  The queued message, above the composer
 *  Ref      |  ROADMAP.md CH7 · thread/queue.ts
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Shows the message that waits behind a running answer,
 *           |  what it waits for, and the three things you can do:
 *           |  let it wait, stop the answer and send it now, or take
 *           |  it back.
 *  How      |  Same line as Claude Code's queue (claudecode/LiveBar):
 *           |  "Queued", the words, "Sends when this turn ends". A
 *           |  message that will not send by itself (the answer ended
 *           |  in an error, or you moved to another branch) says why
 *           |  and offers Send now. Esc in the composer removes it;
 *           |  Remove puts its words back into the composer.
 * ------------------------------------------------------------------
 */

import { Icon } from '../ui/Icon';
import { HELD_WORDS, useQueue } from './queue';
import '../styles/cclive.css';

export function ModelQueue({
  threadId,
  busy,
  onSendNow,
  onRemove,
}: {
  threadId: string;
  /** An answer is still being written. */
  busy: boolean;
  onSendNow: () => void;
  onRemove: () => void;
}) {
  const q = useQueue((s) => s.byThread[threadId]);
  if (!q) return null;
  const held = q.state === 'held';
  return (
    <div
      className="hint-line cc-queued"
      data-failed={held || undefined}
      role={held ? 'alert' : 'status'}
      aria-live={held ? 'assertive' : 'polite'}
    >
      <Icon name={held ? 'warn' : 'clock'} size={12} className="hint-line__icon" />
      <span className="hint-line__text">
        <strong>Queued</strong> {q.text}
      </span>
      <span className="mute cc-queued__when">
        {held && q.why ? HELD_WORDS[q.why] : 'Sends when this turn ends'}
      </span>
      {held || busy ? (
        <button type="button" className="link-btn" onClick={onSendNow}>
          {held ? (q.why === 'branch' ? 'Send here' : 'Send now') : 'Stop and send now'}
        </button>
      ) : null}
      <button
        type="button"
        className="icon-btn icon-btn--xs hint-line__close"
        aria-label="Remove the queued message"
        onClick={onRemove}
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  );
}
