/**
 * ------------------------------------------------------------------
 *  Title    |  Guide chapters that load on demand
 *  Ref      |  ROADMAP GD1, P1 (bundle budget)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Keep the "Providers and paying" chapter (about 180 KB of
 *           |  text) out of the first download. It loads the first time
 *           |  the guide opens or the palette searches the guide.
 *  How      |  loadGuide() imports help/providersGuide.ts once and adds
 *           |  its chapter to the guide's lists (registerChapter), so
 *           |  searchHelp, articleById and citeGuide find it. A view that
 *           |  shows the guide calls useGuideLoaded() to draw again when
 *           |  the chapter arrives.
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
  pending ??= import('./providersGuide')
    .then((m) => {
      registerChapter(m.PROVIDERS_CHAPTER);
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
