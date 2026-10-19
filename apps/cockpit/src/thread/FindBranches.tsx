/**
 * ------------------------------------------------------------------
 *  Title    |  "All branches" in the find bar: where it opens
 *  Ref      |  roadmap TS2 (Pro half) · pro/slot.tsx
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Under the find bar, the hits on the thread's other
 *           |  branches, grouped by branch, each with a jump that
 *           |  switches branch and scrolls to it. Pro's own list
 *           |  (ProUi.parts.FindBranches) fills it; without Pro a gilt
 *           |  line says what it is, so the toggle is never a dead
 *           |  control.
 *  How      |  Public host only: it asks the licence (insights), shows
 *           |  Pro's part when unlocked and the line when not. Nothing
 *           |  is requested until the toggle is on and words are typed.
 * ------------------------------------------------------------------
 */

import { ProNudge } from '../pro/ProNudge';
import { type FindBranchPick, useProFeature } from '../pro/slot';
import '../styles/tsfind.css';

export function FindBranches({
  threadId,
  query,
  currentId,
  pick,
}: {
  threadId: string;
  query: string;
  currentId: string | null;
  pick: (p: FindBranchPick) => void;
}) {
  const { ui, unlocked, build, loading, noSeat } = useProFeature('insights');
  if (loading) return <p className="ts-load mute">Checking Pro</p>;
  const Part = ui?.parts?.FindBranches;
  if (!Part || !unlocked)
    return (
      <ProNudge
        what="Find these words on the other branches of this thread, grouped by branch, with a jump to each."
        build={build}
        noSeat={noSeat}
      />
    );
  return <Part threadId={threadId} query={query} currentId={currentId} pick={pick} />;
}
