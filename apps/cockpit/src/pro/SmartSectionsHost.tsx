/**
 * ------------------------------------------------------------------
 *  Title    |  Smart sections: where they draw in the rail
 *  Ref      |  roadmap TC4 (Pro half) · pro/slot.tsx
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Saved filters ("Claude Code this week", "Cost over
 *           |  $1") as sections in the rail. With Pro and the licence,
 *           |  Pro's own sections (ProUi.parts.SmartSections) draw
 *           |  here; without them one quiet gilt row says what they
 *           |  are and what unlocks them.
 *  How      |  Mounted by the rail between Pinned and Notebooks.
 *           |  Nothing is read from Core until Pro's part loads and
 *           |  the licence unlocks it, so a free build asks for
 *           |  nothing.
 * ------------------------------------------------------------------
 */

import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Icon } from '../ui/Icon';
import { type SmartSectionsProps, useProFeature } from './slot';

export function SmartSectionsHost(props: SmartSectionsProps) {
  const { ui, unlocked, build, loading, noSeat } = useProFeature('smart_sections');
  const [open, setOpen] = useState(false);
  if (loading) return null;
  const Part = ui?.parts?.SmartSections;
  if (Part && unlocked) return <Part {...props} />;
  return (
    <div className="rail__locked gilt-frame gilt-frame--quiet">
      <button type="button" className="rail__ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="seal" size={13} className="gilt-ink" />
        Smart sections
        <span className="rail__pro">Pro</span>
      </button>
      {open ? (
        <p className="rail__empty">
          Save a filter such as “Claude Code this week” or “Cost over $1” and keep it here as a section that
          fills itself.{' '}
          {noSeat
            ? "Pro is on in this workspace, but your account has no Pro seat. Ask the workspace's owner for one."
            : build === 'pro'
              ? 'Turn Pro on with your key to use it.'
              : 'It is part of NVX Ancile Pro, which this build does not include.'}{' '}
          <Link to="/admin/$section" params={{ section: noSeat ? 'team' : 'license' }} className="link-btn">
            {noSeat ? 'See who has a seat' : build === 'pro' ? 'Turn on Pro' : 'About Pro'}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
