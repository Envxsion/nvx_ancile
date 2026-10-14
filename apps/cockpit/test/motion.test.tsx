/**
 * Reduced motion is the in-app setting (Settings → Accessibility → Motion),
 * with "System" read from the OS, everywhere: Motion (through MotionPrefs),
 * every JS check (lib/motion's hook), the theme cross-fade and the CSS
 * (data-motion). Reduced removes movement and keeps short fades.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fade, setTheme } from '@nvx/aperture';
import { DEFAULT_PREFERENCES } from '@nvx/contracts';
import { act, render, screen } from '@testing-library/react';
import { motion, useReducedMotionConfig } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MotionPrefs, reducedMotionNow, scrollBehavior, useReducedMotion } from '../src/lib/motion';
import { lookOf, usePrefs } from '../src/state/prefs';
import { here, read, stripComments, topRules } from './tokenCss';

// ---- An OS that can ask for reduced motion, and change its mind ----------

let osReduces = false;
const listeners = new Set<() => void>();
const realMatchMedia = window.matchMedia;
function setOs(reduce: boolean) {
  osReduces = reduce;
  for (const l of listeners) l();
}
beforeEach(() => {
  osReduces = false;
  listeners.clear();
  window.matchMedia = (query: string) =>
    ({
      get matches() {
        return query.includes('prefers-reduced-motion') && osReduces;
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  usePrefs.setState({ prefs: DEFAULT_PREFERENCES, autoLite: false });
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  usePrefs.setState({ prefs: DEFAULT_PREFERENCES, autoLite: false });
});
const setMotion = (motion: 'system' | 'reduced' | 'full') =>
  act(() => usePrefs.getState().set('accessibility', { motion }));

function Probe() {
  const ours = useReducedMotion();
  // What every motion component reads: MotionConfig's reducedMotion, resolved.
  const motions = useReducedMotionConfig();
  return <output data-testid="probe">{`${ours} ${motions}`}</output>;
}
const probe = () => screen.getByTestId('probe').textContent;

describe('one resolved value, the same one data-motion carries', () => {
  it('Reduced reduces, Full does not even when the OS asks, System follows the OS', () => {
    usePrefs.getState().set('accessibility', { motion: 'reduced' });
    expect(reducedMotionNow()).toBe(true);
    usePrefs.getState().set('accessibility', { motion: 'full' });
    setOs(true);
    expect(reducedMotionNow()).toBe(false);
    usePrefs.getState().set('accessibility', { motion: 'system' });
    expect(reducedMotionNow()).toBe(true);
    setOs(false);
    expect(reducedMotionNow()).toBe(false);
  });

  it('agrees with lookOf, which writes data-motion for the CSS', () => {
    for (const choice of ['system', 'reduced', 'full'] as const)
      for (const os of [false, true]) {
        setOs(os);
        usePrefs.getState().set('accessibility', { motion: choice });
        expect(reducedMotionNow()).toBe(lookOf(usePrefs.getState().prefs).motion === 'reduced');
      }
  });
});

describe('the in-app setting reaches Motion', () => {
  it('MotionPrefs hands Motion "always" or "never", and follows a change live', () => {
    render(
      <MotionPrefs>
        <Probe />
      </MotionPrefs>,
    );
    expect(probe()).toBe('false false');
    setMotion('reduced');
    expect(probe()).toBe('true true');
    setMotion('full');
    act(() => setOs(true));
    // Motion's own config would say true here ("user"); the setting wins.
    expect(probe()).toBe('false false');
    setMotion('system');
    expect(probe()).toBe('true true');
    act(() => setOs(false));
    expect(probe()).toBe('false false');
  });

  it('with motion reduced, Motion jumps the movement and keeps the fade', async () => {
    usePrefs.getState().set('accessibility', { motion: 'reduced' });
    render(
      <MotionPrefs>
        <motion.div
          data-testid="box"
          initial={{ opacity: 0, x: 40 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4 }}
        />
      </MotionPrefs>,
    );
    const box = screen.getByTestId('box');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    // x is already home (no travel); opacity is still on its way (a fade).
    expect(box.style.transform === 'none' || box.style.transform === '').toBe(true);
    const mid = Number(box.style.opacity);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('with motion full, the same element still travels', async () => {
    usePrefs.getState().set('accessibility', { motion: 'full' });
    setOs(true);
    render(
      <MotionPrefs>
        <motion.div
          data-testid="box"
          initial={{ opacity: 0, x: 40 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4 }}
        />
      </MotionPrefs>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(screen.getByTestId('box').style.transform).toMatch(/translateX\((?!0px)/);
  });

  it('JS scrolling is smooth only while motion is full', () => {
    usePrefs.getState().set('accessibility', { motion: 'full' });
    expect(scrollBehavior()).toBe('smooth');
    usePrefs.getState().set('accessibility', { motion: 'reduced' });
    expect(scrollBehavior()).toBe('auto');
  });

  it('the reduced fade is short: 120 ms', () => {
    expect(fade.duration).toBeLessThanOrEqual(0.12);
  });
});

describe('the CSS: one rule, keyed on the resolved data-motion', () => {
  const prefs = stripComments(read('../../../packages/aperture/src/prefs.css'));
  const tokens = stripComments(read('../../../packages/aperture/src/tokens.css'));
  const body = (selector: string) =>
    topRules(prefs).find((r) => r.prelude.split(',').map((s) => s.trim())[0] === selector)?.body ?? '';
  const reducedRoot = body(":root[data-motion='reduced']");
  const reducedAll = body(":root[data-motion='reduced'] *");

  it('caps every duration token longer than 120 ms, so fades stay short', () => {
    const durations = [...tokens.matchAll(/(--d-[\w-]+):\s*(\d+)ms/g)].map(
      (m) => [m[1], Number(m[2])] as const,
    );
    expect(durations.length).toBeGreaterThan(3);
    for (const [name, ms] of durations) {
      if (ms <= 120) continue;
      const capped = reducedRoot.match(new RegExp(`${name}:\\s*(\\d+)ms`));
      expect(capped, `${name} is not capped`).not.toBeNull();
      expect(Number(capped?.[1])).toBeLessThanOrEqual(120);
    }
  });

  it('keeps fades: never zeroes transitions, and opacity stays a transition property', () => {
    expect(prefs).not.toMatch(/transition-duration:\s*0\.01ms/);
    expect(prefs).not.toMatch(/transition:\s*none\s*!important/);
    const props = reducedAll.match(/transition-property:([^;]+);/)?.[1] ?? '';
    expect(props).toMatch(/\bopacity\b/);
    expect(props).toMatch(/\bcolor\b/);
  });

  it('removes movement: no transform, size, position or layout transitions; still keyframes; no smooth scroll', () => {
    const props = (reducedAll.match(/transition-property:([^;]+);/)?.[1] ?? '')
      .split(',')
      .map((p) => p.replace('!important', '').trim());
    for (const moving of [
      'transform',
      'translate',
      'scale',
      'rotate',
      'width',
      'height',
      'top',
      'left',
      'all',
    ])
      expect(props).not.toContain(moving);
    expect(props.some((p) => p.includes('grid'))).toBe(false);
    expect(reducedAll).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(reducedAll).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(reducedAll).toMatch(/scroll-behavior:\s*auto\s*!important/);
    expect(reducedRoot).toMatch(/--press:\s*1;/);
    expect(reducedRoot).toMatch(/--pop-from:\s*1;/);
  });

  it('stands in for the OS only before the look is written (data-motion absent)', () => {
    const media = prefs.slice(prefs.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(media).toContain(':root:not([data-motion])');
    expect(media.slice(0, media.indexOf('\n}\n'))).not.toMatch(/data-motion='/);
  });

  it('no stylesheet asks the OS directly any more', () => {
    // cclive.css is another change in flight: its one rule moves to data-motion with it.
    const PENDING = new Set<string>();
    const dir = here('../src/styles/');
    const sheets = readdirSync(dir).filter((f) => f.endsWith('.css') && !PENDING.has(f));
    const asking = sheets.filter((f) =>
      /prefers-reduced-motion/.test(stripComments(readFileSync(dir + f, 'utf8'))),
    );
    expect(asking).toEqual([]);
    for (const f of ['tokens.css', 'ancile.css', 'pro.css'])
      expect(stripComments(read(`../../../packages/aperture/src/${f}`))).not.toMatch(
        /prefers-reduced-motion/,
      );
    // A rule keyed on a value data-motion never takes is dead (branching.css had 'off').
    for (const f of sheets)
      expect(readFileSync(dir + f, 'utf8'), f).not.toMatch(/data-motion='(?!reduced'|full')/);
  });

  it('no component asks Motion for the OS-only hook', () => {
    const src = here('../src/');
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
    const offenders = files.filter((f) =>
      /import\s*\{[^}]*\buseReducedMotion\b[^}]*\}\s*from\s*'motion\/react'/.test(
        readFileSync(src + f, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  }, 20_000); // scans every source file; slow on Windows
});

describe('the theme cross-fade', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete document.documentElement.dataset.motion;
  });
  it('plays with reduced motion too, as a short fade', () => {
    vi.useFakeTimers();
    const root = document.documentElement;
    root.dataset.motion = 'reduced';
    setTheme('light');
    expect(root.hasAttribute('data-theme-switching')).toBe(true);
    vi.advanceTimersByTime(140);
    expect(root.hasAttribute('data-theme-switching')).toBe(false);
    root.dataset.motion = 'full';
    setTheme('dark');
    vi.advanceTimersByTime(140);
    expect(root.hasAttribute('data-theme-switching')).toBe(true);
    vi.advanceTimersByTime(400);
    expect(root.hasAttribute('data-theme-switching')).toBe(false);
  });
});
