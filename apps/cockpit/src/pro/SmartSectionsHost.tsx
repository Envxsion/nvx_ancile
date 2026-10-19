/**
 * ------------------------------------------------------------------
 *  Title    |  Smart sections: where they draw in the rail
 *  Ref      |  roadmap TC4 (Pro half) · pro/slot.tsx
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Saved filters ("Claude Code this week", "Cost over
 *           |  $1") as sections in the rail. With Pro and the licence,
 *           |  Pro's own sections (ProUi.parts.SmartSections) draw
 *           |  here; without them the rail shows nothing (QU1: the
 *           |  rail is for your work, not offers). Smart sections are
 *           |  found where filters are made, in Ctrl+K's filters.
 *  How      |  Mounted by the rail between Pinned and Notebooks.
 *           |  Nothing is read from Core until Pro's part loads and
 *           |  the licence unlocks it, so a free build asks for
 *           |  nothing.
 * ------------------------------------------------------------------
 */

import { type SmartSectionsProps, useProFeature } from './slot';

export function SmartSectionsHost(props: SmartSectionsProps) {
  const { ui, unlocked, loading } = useProFeature('smart_sections');
  if (loading) return null;
  const Part = ui?.parts?.SmartSections;
  return Part && unlocked ? <Part {...props} /> : null;
}
