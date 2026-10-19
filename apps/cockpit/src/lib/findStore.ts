/**
 * ------------------------------------------------------------------
 *  Title    |  The thread find bar's state
 *  Ref      |  roadmap TS2
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Whether the find bar is open and which match the
 *           |  thread should be showing, so the thread view can jump
 *           |  to it without importing the bar.
 *  How      |  `step` marks a jump from the run timeline (CH4), which
 *           |  needs no find bar. `jump` changes on every step, even to the same
 *           |  message, so stepping twice within one long answer
 *           |  still scrolls and unfolds.
 * ------------------------------------------------------------------
 */

import { create } from 'zustand';
import type { FindHit } from './threadFind';

interface FindState {
  open: boolean;
  /** The thread the bar belongs to; leaving it closes the bar. */
  threadId: string | null;
  jump: { hit: FindHit; n: number; step: boolean } | null;
  show: (threadId: string) => void;
  hide: () => void;
  goTo: (hit: FindHit | null, o?: { step?: boolean }) => void;
}

export const useFind = create<FindState>((set) => ({
  open: false,
  threadId: null,
  jump: null,
  show: (threadId) => set({ open: true, threadId }),
  hide: () => set({ open: false, jump: null }),
  goTo: (hit, o) => set((s) => ({ jump: hit ? { hit, n: (s.jump?.n ?? 0) + 1, step: !!o?.step } : null })),
}));
