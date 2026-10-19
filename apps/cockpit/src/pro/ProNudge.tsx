/**
 * ------------------------------------------------------------------
 *  Title    |  A small "this is part of Pro" line
 *  Ref      |  DESIGN.md §9
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Where a Pro feature sits inside a small public control
 *           |  (the Ctrl+K filters, the find bar) and is not unlocked,
 *           |  say so in one gilt line with the way to turn it on,
 *           |  never a control that does nothing.
 *  How      |  The caller says what Pro adds here; the rest is the
 *           |  same words as the Pro card (slot.tsx ProUpsell). Nothing
 *           |  is requested and nothing can fail; the free build looks
 *           |  exactly like this.
 * ------------------------------------------------------------------
 */

import { Link } from '@tanstack/react-router';
import { Icon } from '../ui/Icon';
import '../styles/tsfind.css';

export function ProNudge({
  what,
  build,
  noSeat,
}: {
  /** One plain sentence: what Pro adds here. */
  what: string;
  build: 'free' | 'pro' | null;
  /** Pro is on in this workspace, but this person has no seat. */
  noSeat: boolean;
}) {
  return (
    <div className="ts-nudge gilt-frame gilt-frame--quiet">
      <Icon name="seal" size={14} />
      <p>
        <span className="gilt-pill">Pro</span> {what}{' '}
        {noSeat
          ? 'Your account has no Pro seat: ask the workspace owner for one.'
          : build === 'pro'
            ? 'Turn Pro on with your key to use it.'
            : 'This build does not include Pro; everything else here is free.'}
      </p>
      {noSeat ? (
        <Link to="/admin/$section" params={{ section: 'team' }} className="btn btn--ghost btn--sm">
          See who has a seat
        </Link>
      ) : (
        <Link to="/admin/$section" params={{ section: 'license' }} className="btn btn--ghost btn--sm">
          {build === 'pro' ? 'Turn on Pro' : 'About Pro'}
        </Link>
      )}
    </div>
  );
}
