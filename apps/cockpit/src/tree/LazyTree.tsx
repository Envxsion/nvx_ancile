/**
 * ------------------------------------------------------------------
 *  Title    |  Lazy branch tree
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The tree brings a layout engine and a canvas; they load
 *           |  the first time a tree is shown, not with the app.
 * ------------------------------------------------------------------
 */

import { lazy, Suspense } from 'react';
import { Skeleton } from '../ui/primitives';

const Tree = lazy(() => import('./BranchTree').then((m) => ({ default: m.BranchTree })));

export function LazyBranchTree(props: { threadId: string; variant?: 'panel' | 'full' }) {
  return (
    <Suspense fallback={<Skeleton lines={5} label="Loading the tree" />}>
      <Tree {...props} />
    </Suspense>
  );
}
