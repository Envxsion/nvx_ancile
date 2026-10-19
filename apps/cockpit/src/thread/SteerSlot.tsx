/**
 * ------------------------------------------------------------------
 *  Title    |  The queued message: steer it in (Pro seam)
 *  Ref      |  ROADMAP.md CH7 (Pro half) · pro/slot.tsx
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Beside a queued message, say what happens to it. Free:
 *           |  "Sends when this turn ends". With Pro and the licence,
 *           |  Pro's control (parts.SteerQueue) may offer it to the
 *           |  running answer as a note the model reads at its next
 *           |  step; without them, one quiet line says what unlocks it.
 *  How      |  Draws nothing about the note itself: Pro's part does,
 *           |  and falls back to the free words where the answer
 *           |  cannot take a note (a flow, Claude Code, a message with
 *           |  files). The queue's own state (thread/queue.ts) holds
 *           |  what became of it.
 * ------------------------------------------------------------------
 */

import { Link } from '@tanstack/react-router';
import { useProFeature } from '../pro/slot';
import { hold, isPlain, type QueuedSend, setSteer } from './queue';

const FREE_WORDS = 'Sends when this turn ends';

export function SteerSlot({ threadId, q, busy }: { threadId: string; q: QueuedSend; busy: boolean }) {
  const { ui, unlocked, loading, build } = useProFeature('steer');
  const Control = ui?.parts?.SteerQueue;
  const live = busy && q.state === 'waiting';
  if (Control && unlocked && live)
    return (
      <Control
        threadId={threadId}
        text={q.text}
        after={q.after}
        plain={isPlain(q.extras)}
        steer={q.steer ?? null}
        onSteer={(s) => setSteer(threadId, s)}
        onBranchChanged={() => hold(threadId, 'branch')}
      />
    );
  return (
    <>
      <span className="mute cc-queued__when">{FREE_WORDS}</span>
      {!loading && !unlocked && live ? (
        <span className="mute cc-queued__pro gilt-frame gilt-frame--quiet">
          Add it as a note the model reads at its next step: part of Pro.{' '}
          <Link to="/admin/$section" params={{ section: 'license' }} className="link-btn">
            {build === 'pro' ? 'Turn on Pro' : 'About Pro'}
          </Link>
        </span>
      ) : null}
    </>
  );
}
