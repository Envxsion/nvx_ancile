/**
 * ------------------------------------------------------------------
 *  Title    |  Status bar: update pill and warming
 *  Ref      |  ROADMAP rows UP1, P6
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  A quiet pill when an update is on offer or moving, and
 *           |  a note while the desktop app's other services are
 *           |  still warming up after the window opened.
 *  How      |  Both read what Core says (the update offer; the
 *           |  desktop state the shell keeps up to date) and render
 *           |  nothing in a browser tab. The pill opens Settings →
 *           |  Desktop, where the buttons are.
 * ------------------------------------------------------------------
 */

import { Link } from '@tanstack/react-router';
import { isDesktop } from '../lib/runtime';
import { Icon } from '../ui/Icon';
import { Tip } from '../ui/primitives';
import { offerLine, useDesktopState, useUpdateOffer } from './api';

export function UpdatePill() {
  const offer = useUpdateOffer().data?.offer;
  if (!isDesktop() || !offer) return null;
  const line = offerLine(offer);
  const pct = Math.round((offer.progress ?? 0) * 100);
  return (
    <Tip label={`${line}. Open update settings`}>
      <Link
        to="/settings/$group"
        params={{ group: 'desktop' }}
        className="status-seg status-seg--update"
        data-state={offer.state}
        aria-label={`Update: ${line}`}
      >
        <Icon name="download" size={13} />
        <span>{offer.state === 'available' ? `Update ${offer.version}` : line}</span>
        <span className="update-pill__bar" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
      </Link>
    </Tip>
  );
}

/** "Warming up: sources and search" while the rest of the app starts beside the open window. */
export function WarmingSegment() {
  const warming = useDesktopState().data?.warming ?? [];
  if (!isDesktop() || warming.length === 0) return null;
  return (
    <span className="status-seg status-seg--static status-seg--warming" role="status">
      <Icon name="clock" size={13} />
      <span>Warming up: {warming.join(', ')}</span>
    </span>
  );
}
