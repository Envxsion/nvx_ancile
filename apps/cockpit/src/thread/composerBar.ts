/**
 * ------------------------------------------------------------------
 *  Title    |  Composer bar fit
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Decide how the composer's toolbar fits its width: chips
 *           |  with their whole label, a short label, or the icon
 *           |  alone, and whether the key hint still has room.
 *  How      |  A ResizeObserver on the composer measures its width;
 *           |  composerBar() turns width and chip count into a fit,
 *           |  and the component only re-renders when the fit changes.
 *           |  CSS shows the matching label (composer.css, data-bar).
 *  Note     |  Labels never truncate mid-word: a chip that does not
 *           |  fit drops to the next step instead. The hint moves into
 *           |  the Send button's tooltip when it is hidden.
 * ------------------------------------------------------------------
 */

import { type RefObject, useLayoutEffect, useState } from 'react';

export type BarFit = 'full' | 'short' | 'icon';
export interface BarLayout {
  fit: BarFit;
  /** The "Enter to send" line has room beside the chips. */
  hint: boolean;
}

/** Send, three icon buttons (attach, images, compare), the bar's gaps and the composer's padding. */
const FIXED = 36 + 3 * 30 + 40;
/** A chip's width at each step, generous so a long model name still fits. */
const CHIP: Record<BarFit, number> = { full: 172, short: 108, icon: 44 };
const HINT = 230;

/** How the bar fits `width` CSS pixels with `chips` chips on it. 0 means not measured yet. */
export function composerBar(width: number, chips: number): BarLayout {
  if (width <= 0) return { fit: 'full', hint: true };
  const room = width - FIXED;
  const n = Math.max(0, chips);
  const fit: BarFit = room >= n * CHIP.full ? 'full' : room >= n * CHIP.short ? 'short' : 'icon';
  return { fit, hint: room - n * CHIP[fit] >= HINT };
}

/**
 * A model's name, short: no vendor in front ("anthropic/", "Claude "),
 * no release date at the end, at most two words. Whole words only.
 */
export function shortModelName(name: string): string {
  let s = name.trim();
  if (/^default model$/i.test(s)) return 'Default';
  s = s.slice(s.lastIndexOf('/') + 1);
  s = s.replace(/[-@_ ]?\d{8}$/, '').replace(/^claude[- ]/i, '');
  const words = s.split(/\s+/).filter(Boolean);
  return (words.length > 2 ? words.slice(0, 2).join(' ') : words.join(' ')) || name;
}

/** The bar's fit for the element in `ref`, updated as it resizes. */
export function useComposerBar(ref: RefObject<HTMLElement | null>, chips: number): BarLayout {
  const [layout, setLayout] = useState<BarLayout>(() => composerBar(0, chips));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (width: number) =>
      setLayout((was) => {
        const next = composerBar(width, chips);
        return next.fit === was.fit && next.hint === was.hint ? was : next;
      });
    apply(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) apply(box.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, chips]);
  return layout;
}
