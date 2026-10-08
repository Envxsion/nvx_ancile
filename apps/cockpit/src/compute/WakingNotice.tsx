/**
 * ------------------------------------------------------------------
 *  Title    |  Waking your GPU node
 *  Ref      |  DESIGN.md §7.3 · ROADMAP.md Phase 5
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  When the model you asked runs on a node that is asleep,
 *           |  the answer waits where you can see it: which node, how
 *           |  long it usually takes, a bar that fills towards it, and
 *           |  "Use a cloud model instead" if you would rather not.
 *  How      |  Reads the live turn's `waking` (run.ts, from the
 *           |  compute.waiting event); clears itself when text arrives.
 * ------------------------------------------------------------------
 */

import { type CSSProperties, useEffect, useState } from 'react';
import { useRuns } from '../lib/run';
import { Icon } from '../ui/Icon';
import { chooseCloud } from './data';

export function WakingNotice({ messageId }: { messageId: string }) {
  const waking = useRuns((s) => s.turns[messageId]?.waking ?? null);
  const runId = useRuns((s) => s.turns[messageId]?.runId ?? null);
  const [now, setNow] = useState(() => Date.now());
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!waking) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [waking]);
  if (!waking) return null;

  const elapsed = Math.max(0, Math.round((now - Date.parse(waking.since)) / 1000));
  const eta = waking.etaS ?? 120;
  const progress = Math.min(0.95, elapsed / Math.max(eta, 1));
  const left = Math.max(0, eta - elapsed);
  const node = /^(.+?) is /.exec(waking.detail ?? '')?.[1] ?? 'your GPU node';

  return (
    <div className="waking" role="status" aria-live="polite" style={{ '--p': progress } as CSSProperties}>
      <span className="waking__glyph" aria-hidden="true">
        <Icon name="node" size={15} />
      </span>
      <div className="waking__main">
        <span className="waking__title">Waking {node}</span>
        <span className="waking__detail mute">
          {left > 0
            ? `Usually ready in about ${left < 60 ? `${left} s` : `${Math.round(left / 60)} min`}.`
            : 'Nearly there.'}{' '}
          The answer starts here as soon as it is up.
        </span>
        <span className="waking__bar" aria-hidden="true">
          <span />
        </span>
      </div>
      {waking.canUseCloud && runId ? (
        <button
          type="button"
          className="btn btn--sm"
          disabled={asked}
          onClick={() => {
            setAsked(true);
            void chooseCloud(runId);
          }}
        >
          {asked ? 'Switching…' : 'Use a cloud model instead'}
        </button>
      ) : null}
    </div>
  );
}
