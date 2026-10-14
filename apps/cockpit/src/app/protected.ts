/**
 * ------------------------------------------------------------------
 *  Title    |  Protected layer
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Permission requests and the permission settings are
 *           |  shown where a person's own CSS cannot reach them: it
 *           |  could hide a request, cover it, or dress Allow up as
 *           |  Decline.
 *  How      |  Protected UI portals into one container of its own,
 *           |  above every other layer, and counts itself open with
 *           |  useProtect(): while anything protected is open the
 *           |  custom CSS is switched off (Runtime). A visibility
 *           |  check then confirms the request really can be seen and
 *           |  is not covered; until it can, its answers stay
 *           |  disabled.
 *  Note     |  Layout is unavailable in tests (jsdom): a check that
 *           |  cannot measure answers "visible" rather than block.
 * ------------------------------------------------------------------
 */

import { type RefObject, useEffect, useState } from 'react';
import { create } from 'zustand';

/** How many protected surfaces are open now. */
export const useProtected = create<{ open: number }>(() => ({ open: 0 }));

const LAYER_ID = 'ancile-protected';

/** The container protected UI portals into, made on first use. */
export function protectedLayer(): HTMLElement {
  const found = document.getElementById(LAYER_ID);
  if (found) return found;
  const el = document.createElement('div');
  el.id = LAYER_ID;
  el.dataset.protected = '';
  document.body.appendChild(el);
  return el;
}

/** While `on`, this surface counts as open: the custom CSS is off. */
export function useProtect(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    useProtected.setState((s) => ({ open: s.open + 1 }));
    return () => useProtected.setState((s) => ({ open: Math.max(0, s.open - 1) }));
  }, [on]);
}

export type HiddenReason = 'hidden' | 'off_screen' | 'too_small' | 'covered';

interface Env {
  innerWidth: number;
  innerHeight: number;
  elementFromPoint?: (x: number, y: number) => Element | null;
  getComputedStyle: (el: Element) => Pick<CSSStyleDeclaration, 'display' | 'visibility' | 'opacity'>;
}

const browserEnv = (): Env => ({
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  elementFromPoint:
    typeof document.elementFromPoint === 'function' ? (x, y) => document.elementFromPoint(x, y) : undefined,
  getComputedStyle: (el) => window.getComputedStyle(el),
});

/**
 * Why `el` cannot be seen and used, or null when it can. Each control
 * marked data-protected-action must be the topmost thing at its centre.
 */
export function hiddenReason(el: HTMLElement, env: Env = browserEnv()): HiddenReason | null {
  const check = (el as HTMLElement & { checkVisibility?: (o: object) => boolean }).checkVisibility;
  if (typeof check === 'function') {
    if (!check.call(el, { opacityProperty: true, visibilityProperty: true })) return 'hidden';
  } else {
    // Older engines: walk up and look for what hides it.
    for (let n: Element | null = el; n; n = n.parentElement) {
      const cs = env.getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return 'hidden';
    }
  }
  const r = el.getBoundingClientRect();
  // No layout at all (jsdom): nothing to measure, nothing to refuse.
  if (r.width === 0 && r.height === 0 && !env.elementFromPoint) return null;
  if (r.width < 120 || r.height < 60) return 'too_small';
  if (r.bottom <= 0 || r.right <= 0 || r.top >= env.innerHeight || r.left >= env.innerWidth)
    return 'off_screen';
  if (!env.elementFromPoint) return null;
  for (const b of el.querySelectorAll<HTMLElement>('[data-protected-action]')) {
    const br = b.getBoundingClientRect();
    if (br.width === 0 || br.height === 0) continue;
    const hit = env.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
    if (!hit || !b.contains(hit)) return 'covered';
  }
  return null;
}

/**
 * Keeps checking that the element can be seen while `on`: right away, once
 * its entrance has settled, then every second and on resize. Answers true
 * while it can.
 */
export function useVisibilityCheck(ref: RefObject<HTMLElement | null>, on: boolean): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (!on) return;
    const run = () => {
      const el = ref.current;
      if (el) setVisible(hiddenReason(el) === null);
    };
    const first = setTimeout(run, 250);
    const every = setInterval(run, 1000);
    window.addEventListener('resize', run);
    return () => {
      clearTimeout(first);
      clearInterval(every);
      window.removeEventListener('resize', run);
    };
  }, [ref, on]);
  return visible;
}
