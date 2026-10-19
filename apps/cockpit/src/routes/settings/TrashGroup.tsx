/**
 * ------------------------------------------------------------------
 *  Title    |  Settings: Trash
 *  Ref      |  ROADMAP TC4 · guard rail GR23
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The same Trash as the rail's Archive area, reached
 *           |  from Settings: deleted threads, restore, empty.
 *  How      |  The view itself loads on demand, so Settings pays
 *           |  for it only when this group is open.
 * ------------------------------------------------------------------
 */

import { lazy, Suspense, useContext } from 'react';
import { Skeleton } from '../../ui/primitives';
import { Block, matches, SearchContext } from './rows';

const TrashView = lazy(() => import('../../shell/TrashView').then((m) => ({ default: m.TrashView })));

export function TrashGroup() {
  const q = useContext(SearchContext);
  if (!matches(q, 'Trash', 'deleted threads restore empty trash 30 days')) return null;
  return (
    <Block title="Deleted threads" lede="Kept for 30 days, then removed for good.">
      <div className="setting" data-stack>
        <Suspense fallback={<Skeleton lines={4} label="Loading the Trash" />}>
          <TrashView />
        </Suspense>
      </div>
    </Block>
  );
}
