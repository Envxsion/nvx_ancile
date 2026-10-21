/**
 * ------------------------------------------------------------------
 *  Title    |  Guide chapters that load on demand
 *  Ref      |  ROADMAP GD1, P1 (bundle budget)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Keep the guide's text (the core articles in coreGuide.ts
 *           |  and the 180 KB "Providers and paying" chapter) out of the
 *           |  first download. It loads the first time the guide opens,
 *           |  the palette searches the guide, or a "Read more" link is
 *           |  followed.
 *  How      |  loadGuide() imports help/coreGuide.ts and
 *           |  help/providersGuide.ts once, in that order, and adds
 *           |  their chapters to the guide's lists (registerChapter), so
 *           |  searchHelp, articleById and citeGuide find them. A view
 *           |  that shows the guide calls useGuideLoaded() to draw again
 *           |  when the chapters arrive.
 *  Note     |  Nothing here may be imported by the stores or the event
 *           |  handler (test/lazyBoundary.test.ts).
 * ------------------------------------------------------------------
 */

import { useSyncExternalStore } from 'react';
import { registerChapter } from './articles';

let loaded = false;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Load the lazy chapters (once). Resolves when they are in the guide; a failed load can be tried again. */
export function loadGuide(): Promise<void> {
  pending ??= Promise.all([import('./coreGuide'), import('./providersGuide')])
    .then(([core, providers]) => {
      for (const c of core.CORE_CHAPTERS) registerChapter(c);
      registerChapter(providers.PROVIDERS_CHAPTER);
      loaded = true;
      for (const l of listeners) l();
    })
    .catch((e: unknown) => {
      pending = null;
      throw e;
    });
  return pending;
}

/** Whether the lazy chapters are in the guide yet. */
export const guideLoaded = (): boolean => loaded;

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** True once the lazy chapters are in; a component that reads the guide draws again when it flips. */
export function useGuideLoaded(): boolean {
  return useSyncExternalStore(subscribe, guideLoaded, guideLoaded);
}
