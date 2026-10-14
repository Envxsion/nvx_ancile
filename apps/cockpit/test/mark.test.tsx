/**
 * The mark in the titlebar never freezes: every part that turns, breathes,
 * beats or shakes is a box of its own (an outermost <svg>), so the browser
 * runs its animation on the compositor. A transform on a path inside one
 * SVG is redrawn on the main thread every frame, and the ring stopped
 * whenever the app was busy, an answer streaming in above all.
 */

import { AncileMark, type MarkState } from '@nvx/aperture';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { read, splitTop, stripComments, topRules } from './tokenCss';

const css = stripComments(read('../../../packages/aperture/src/ancile.css'));
/** Every selector in ancile.css that moves something: an animation, or a translate. */
const moving = topRules(css)
  .filter((r) => /(^|[;\s])(animation(-name)?|translate|rotate|scale)\s*:/.test(r.body))
  .flatMap((r) => splitTop(r.prelude, ','))
  .map((s) => s.trim())
  .filter((s) => s.includes('ancile-mark'));

const STATES: MarkState[] = ['idle', 'thinking', 'streaming', 'ask', 'offline', 'alarm'];

describe('the mark animates on the compositor', () => {
  it('finds the rules that move it', () => {
    expect(moving.length).toBeGreaterThanOrEqual(8);
  });

  it.each(STATES)('in %s, everything that moves is a box, never a shape inside an SVG', (state) => {
    const { container } = render(<AncileMark size={22} state={state} />);
    const mark = container.querySelector('.ancile-mark');
    expect(mark?.tagName.toLowerCase()).toBe('span');
    let matched = 0;
    for (const sel of moving) {
      for (const el of container.querySelectorAll(sel)) {
        matched++;
        // An outermost <svg> (or an HTML element) has no ownerSVGElement.
        expect((el as SVGElement).ownerSVGElement ?? null, `${sel} moves a shape inside an SVG`).toBeNull();
      }
    }
    if (state !== 'offline') expect(matched).toBeGreaterThan(0);
  });

  it('keeps the geometry: the four parts on one 34-unit grid, the size asked for', () => {
    const { container } = render(<AncileMark size={44} label="NVX Ancile" />);
    const mark = container.querySelector<HTMLElement>('.ancile-mark');
    expect(mark).toHaveAttribute('role', 'img');
    expect(mark).toHaveAttribute('aria-label', 'NVX Ancile');
    expect(mark?.style.width).toBe('44px');
    const parts = [...container.querySelectorAll('svg.ancile-mark__part')];
    expect(parts.map((p) => p.getAttribute('class'))).toEqual([
      'ancile-mark__part half half-l',
      'ancile-mark__part half half-r',
      'ancile-mark__part inner',
      'ancile-mark__part core',
    ]);
    for (const p of parts) expect(p.getAttribute('viewBox')).toBe('0 0 34 34');
  });
});
