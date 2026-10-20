/**
 * ------------------------------------------------------------------
 *  Title    |  Settings → Decisions
 *  Ref      |  docs/decisions.md · DESIGN.md D30
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Where decision models are set up: use free allowances
 *           |  first, see how much of each is used, switch a route
 *           |  off, cap the spend, and point at a decision server on
 *           |  this computer or your own GPU node.
 *  How      |  A thin wrapper that loads the panel on first open, so
 *           |  the main bundle does not carry it. The panel reads GET
 *           |  /decisions and saves with PUT /decisions/settings.
 *  Note     |  QU1: one switch, one meter, a list of routes with their
 *           |  state in words. Per-task choice and side-by-side
 *           |  scoring are Pro (Flow lab).
 * ------------------------------------------------------------------
 */

import { lazy, Suspense } from 'react';
import { Skeleton } from '../ui/primitives';

const Panel = lazy(() => import('./DecisionsPanel'));

/** Settings → Decisions. */
export function DecisionsGroup() {
  return (
    <Suspense
      fallback={
        <div className="setting" data-stack>
          <Skeleton lines={4} label="Loading decision settings" />
        </div>
      }
    >
      <Panel />
    </Suspense>
  );
}
