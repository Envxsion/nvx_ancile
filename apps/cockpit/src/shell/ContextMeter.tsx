/**
 * ------------------------------------------------------------------
 *  Title    |  Context meter
 *  Ref      |  DESIGN.md §8.4
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  How full this branch is for the model that would answer
 *           |  it, in the status bar: a meter, a number, and the parts
 *           |  that make it up on hover. Past 80% it offers to compact.
 *  How      |  GET /threads/:id/context-budget for the open thread,
 *           |  refreshed with the thread. The fill springs to its new
 *           |  width; the number ticks. On demo data it shows the
 *           |  sample figures.
 * ------------------------------------------------------------------
 */

import { compactNow, useContextBudget } from '../lib/branching';
import { compact, percent } from '../lib/format';
import { useThreadIdFromRoute } from '../lib/models';
import { useUi } from '../state/ui';
import { Ticker } from '../ui/controls';
import { Tip } from '../ui/primitives';

function Meter({ ratio, level }: { ratio: number; level: 'ok' | 'warn' | 'critical' }) {
  return (
    <>
      <span className="meter" data-level={level}>
        <span className="meter__fill" style={{ width: percent(Math.min(1, ratio)) }} />
      </span>
      <Ticker value={ratio * 100} format={(v) => `${Math.round(v)}%`} />
      <span className="mute">context</span>
    </>
  );
}

export function ContextMeter() {
  const demo = useUi((s) => s.demo);
  const live = useUi((s) => s.live.context);
  const threadId = useThreadIdFromRoute();
  const budget = useContextBudget(demo ? undefined : threadId);

  if (demo) {
    const level = live.ratio >= 0.95 ? 'critical' : live.ratio >= 0.8 ? 'warn' : 'ok';
    return (
      <div
        className="status-seg status-seg--static"
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(live.ratio * 100)}
        data-level={level}
        title={`${compact(live.used)} of ${compact(live.window)} tokens`}
      >
        <Meter ratio={live.ratio} level={level} />
      </div>
    );
  }

  const b = budget.data;
  if (!threadId || !b || b.window === 0) return null;
  const u = b.used;
  const label = [
    `${compact(b.total)} of ${compact(b.window)} tokens for this branch.`,
    `History ${compact(u.history)}${b.compaction ? ' (with a summary)' : ''}, system ${compact(u.system)}, room for the reply ${compact(u.reserve_output)}.`,
    b.level !== 'ok' && b.compactable > 0 ? 'Click to compact the older messages.' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const canCompact = b.level !== 'ok' && b.compactable > 0;

  return (
    <Tip label={label}>
      <button
        type="button"
        className="status-seg"
        data-level={b.level}
        data-tour="context-meter"
        aria-label={`Context used: ${percent(b.ratio)}. ${label}`}
        onClick={() => (canCompact ? void compactNow(threadId) : undefined)}
        aria-disabled={!canCompact || undefined}
      >
        <Meter ratio={b.ratio} level={b.level} />
      </button>
    </Tip>
  );
}
