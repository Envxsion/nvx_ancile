/**
 * ------------------------------------------------------------------
 *  Title    |  Help progress
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  What this person has learned already: tours finished or
 *           |  skipped, checklist steps done, hints seen. So help
 *           |  pulses once, offers each tour once, and gets out of the
 *           |  way when it is no longer needed.
 *  How      |  Zustand persisted to localStorage, mirrored to Core
 *           |  under ui-state "help". `done(step)` is called from the
 *           |  places where the real action happens, never from a
 *           |  "Mark as done" button.
 * ------------------------------------------------------------------
 */

import { HelpProgress } from '@nvx/contracts';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { api } from '../lib/api';

export type ChecklistStep =
  | 'first-thread'
  | 'switch-model'
  | 'notebook'
  | 'source'
  | 'cite'
  | 'palette'
  | 'branch'
  | 'flow'
  | 'settings';

interface HelpState extends HelpProgress {
  /** The tour running now, and its step. */
  tour: { id: string; step: number } | null;
  done: (step: ChecklistStep) => void;
  seeHint: (id: string) => void;
  startTour: (id: string) => void;
  stepTour: (delta: number) => void;
  endTour: (outcome: 'done' | 'skipped') => void;
  dismissChecklist: () => void;
  resetHelp: () => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;
function sync(s: HelpProgress) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const { tours, checklist, hintsSeen, lastSeenVersion } = s;
    void api
      .put('/ui-state/help', { value: { tours, checklist, hintsSeen, lastSeenVersion } })
      .catch(() => undefined);
  }, 1_000);
}

const EMPTY = HelpProgress.parse({});

export const useHelp = create<HelpState>()(
  persist(
    (set, get) => ({
      ...EMPTY,
      tour: null,
      done: (step) => {
        if (get().checklist[step]) return;
        set((s) => ({ checklist: { ...s.checklist, [step]: true } }));
        sync(get());
      },
      seeHint: (id) => {
        if (get().hintsSeen.includes(id)) return;
        set((s) => ({ hintsSeen: [...s.hintsSeen, id].slice(-500) }));
        sync(get());
      },
      startTour: (id) => set({ tour: { id, step: 0 } }),
      stepTour: (delta) =>
        set((s) => (s.tour ? { tour: { ...s.tour, step: Math.max(0, s.tour.step + delta) } } : s)),
      endTour: (outcome) => {
        const t = get().tour;
        if (!t) return;
        set((s) => ({ tour: null, tours: { ...s.tours, [t.id]: outcome } }));
        sync(get());
      },
      dismissChecklist: () => {
        set((s) => ({ checklist: { ...s.checklist, dismissed: true } }));
        sync(get());
      },
      resetHelp: () => {
        set({ ...EMPTY, tour: null });
        sync(get());
      },
    }),
    {
      name: 'nvx.ancile.help',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        tours: s.tours,
        checklist: s.checklist,
        hintsSeen: s.hintsSeen,
        lastSeenVersion: s.lastSeenVersion,
      }),
    },
  ),
);

/** Mark a checklist step from anywhere, outside React. */
export const helpDone = (step: ChecklistStep) => useHelp.getState().done(step);
