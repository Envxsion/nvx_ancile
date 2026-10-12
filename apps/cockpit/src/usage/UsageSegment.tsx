/**
 * ------------------------------------------------------------------
 *  Title    |  Usage in the status bar
 *  Ref      |  DESIGN.md §13.1 · docs/claude-code.md (Usage)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A glance at Claude Code's plan limits, and the way to
 *           |  Settings → Usage.
 *  How      |  With a plan sign-in: the 5-hour session's meter and
 *           |  share, the week's in the tooltip. Otherwise one quiet
 *           |  "Usage". Which segments show is Settings → Layout.
 * ------------------------------------------------------------------
 */

import { Link } from '@tanstack/react-router';
import { Icon } from '../ui/Icon';
import { Tip } from '../ui/primitives';
import { toneOf, usePlanLimits, windowLine } from './api';
import { Meter } from './Meter';

export function UsageSegment() {
  const limits = usePlanLimits().data;
  const shown =
    limits?.available !== false
      ? (limits?.windows.find((w) => w.kind === 'session' && w.percent !== null) ??
        limits?.windows.find((w) => w.kind === 'week' && w.percent !== null))
      : undefined;
  const lines = (limits?.windows ?? []).filter((w) => w.kind !== 'other').map((w) => windowLine(w));
  const label = lines.length ? `${lines.join('. ')}. Open usage` : 'Open usage';
  return (
    <Tip label={label}>
      <Link
        to="/settings/$group"
        params={{ group: 'usage' }}
        className="status-seg"
        data-level={shown ? { calm: 'ok', high: 'warn', over: 'critical' }[toneOf(shown.percent)] : undefined}
        aria-label={label}
      >
        {shown && shown.percent !== null ? (
          <>
            <Meter percent={shown.percent} label={windowLine(shown)} />
            <span data-num>{Math.round(shown.percent)}%</span>
            <span className="mute">{shown.kind === 'session' ? '5h' : 'week'}</span>
          </>
        ) : (
          <>
            <Icon name="pulse" size={12} />
            <span className="mute">Usage</span>
          </>
        )}
      </Link>
    </Tip>
  );
}
