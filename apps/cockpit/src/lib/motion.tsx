/**
 * ------------------------------------------------------------------
 *  Title    |  Reduced motion, as the person chose it
 *  Ref      |  aperture/prefs.css (Motion) · Settings → Accessibility
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  One answer to "should this move?" for every JS caller:
 *           |  the in-app Motion setting, with "System" read from the
 *           |  OS. The same value data-motion carries for CSS.
 *  How      |  useReducedMotion() reads lookOf(prefs).motion, the very
 *           |  function that writes data-motion, and re-reads it when
 *           |  the setting or the OS changes. <MotionPrefs> hands it
 *           |  to Motion as reducedMotion "always" or "never", so Motion
 *           |  drops transforms and layout moves and keeps opacity (the
 *           |  short fades). Motion's own useReducedMotion reads only
 *           |  the OS: nothing in the Cockpit imports it.
 *  Note     |  Motion fixes the choice when an element mounts. Most
 *           |  moving things mount as they appear, so they follow a
 *           |  change at once; a long-lived element that animates on
 *           |  its own (the Ticker) asks this hook instead.
 * ------------------------------------------------------------------
 */

import { MotionConfig } from 'motion/react';
import { type ReactNode, useSyncExternalStore } from 'react';
import { lookOf, usePrefs } from '../state/prefs';

const OS_QUERY = '(prefers-reduced-motion: reduce)';

function osQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(OS_QUERY) : null;
}

function subscribe(notify: () => void): () => void {
  const unsub = usePrefs.subscribe((s, prev) => {
    if (s.prefs.accessibility.motion !== prev.prefs.accessibility.motion) notify();
  });
  const mq = osQuery();
  mq?.addEventListener('change', notify);
  return () => {
    unsub();
    mq?.removeEventListener('change', notify);
  };
}

/** True when motion is reduced: the in-app choice, or the OS while it is "System". */
export function reducedMotionNow(): boolean {
  return lookOf(usePrefs.getState().prefs).motion === 'reduced';
}

/** The resolved Motion setting, live. Use this, never Motion's OS-only hook. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, reducedMotionNow, () => false);
}

/** Motion's config for the whole app, driven by the resolved setting. */
export function MotionPrefs({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  return <MotionConfig reducedMotion={reduce ? 'always' : 'never'}>{children}</MotionConfig>;
}

/** For scrollIntoView and scrollTo: smooth only while motion is full. */
export function scrollBehavior(): ScrollBehavior {
  return reducedMotionNow() ? 'auto' : 'smooth';
}
