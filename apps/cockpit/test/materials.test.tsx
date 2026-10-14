/**
 * Glass, grain and gilt are visible, and Settings says so when something
 * else overrides them: glass beats every component ground it is laid on
 * (and steps aside for Solid, reduced transparency and Light effects), the
 * grain shows on the near-black grounds as well as the light ones, gilt On
 * is a different thing from Subtle, and each Materials row (and the rows
 * that override them) carries a note while an override is in force.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolveLook } from '@nvx/aperture';
import { DEFAULT_PREFERENCES, Preferences } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, to, params }: { children: ReactNode; to: string; params?: Record<string, string> }) => (
    <a href={to.replace(/\$(\w+)/g, (_, k: string) => params?.[k] ?? k)}>{children}</a>
  ),
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  const ok = () => Promise.resolve({});
  return {
    ...real,
    api: { get: vi.fn(ok), post: vi.fn(ok), put: vi.fn(ok), patch: vi.fn(ok), del: vi.fn(ok) },
  };
});

import { queryClient } from '../src/lib/query';
import { AccessibilityGroup, AdvancedGroup, AppearanceGroup } from '../src/routes/settings/groups';
import { lookOverride } from '../src/routes/settings/rows';
import { lookOf, usePrefs } from '../src/state/prefs';
import {
  here,
  oklab,
  parse,
  read,
  specificity,
  splitTop,
  stripComments,
  tokensFor,
  topRules,
} from './tokenCss';

// ---- An OS whose transparency and motion preferences tests can set -------

const os = { transparency: false, motion: false };
const listeners = new Set<() => void>();
const realMatchMedia = window.matchMedia;
beforeEach(() => {
  os.transparency = false;
  os.motion = false;
  window.matchMedia = (query: string) =>
    ({
      get matches() {
        return query.includes('reduced-transparency')
          ? os.transparency
          : query.includes('reduced-motion') && os.motion;
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
  listeners.clear();
  usePrefs.setState({ prefs: DEFAULT_PREFERENCES, autoLite: false });
});
const setOs = (patch: Partial<typeof os>) =>
  act(() => {
    Object.assign(os, patch);
    for (const l of listeners) l();
  });
const prefs = (p: unknown) => Preferences.parse(p);

describe('what overrides glass and grain, read from the resolved look', () => {
  it('nothing, by default and with Effects always on even when the governor wants lite', () => {
    expect(lookOverride(prefs({}), false)).toBeNull();
    expect(lookOverride(prefs({ advanced: { performance: 'full' } }), true)).toBeNull();
    expect(lookOverride(prefs({ advanced: { performance: 'auto' } }), false)).toBeNull();
  });

  it('Transparency reduced here, or by the system', () => {
    expect(lookOverride(prefs({ accessibility: { transparency: 'reduced' } }), false)).toBe('transparency');
    os.transparency = true;
    expect(lookOverride(prefs({}), false)).toBe('system-transparency');
  });

  it('Effects Light, or Automatic while the governor has it light', () => {
    expect(lookOverride(prefs({ advanced: { performance: 'lite' } }), false)).toBe('effects');
    expect(lookOverride(prefs({ advanced: { performance: 'auto' } }), true)).toBe('effects-auto');
  });

  it('Transparency is named first when both apply (it is the person’s own choice)', () => {
    const p = prefs({ accessibility: { transparency: 'reduced' }, advanced: { performance: 'lite' } });
    expect(lookOverride(p, true)).toBe('transparency');
  });

  it('matches what the document wears: reduced transparency makes the material solid and the grain off', () => {
    const { attrs } = resolveLook(lookOf(prefs({ accessibility: { transparency: 'reduced' } })));
    expect(attrs.material).toBe('solid');
    expect(attrs.grain).toBe('off');
    expect(resolveLook(lookOf(prefs({ advanced: { performance: 'lite' } }))).attrs.fx).toBe('lite');
  });
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{children}</Tooltip.Provider>
    </QueryClientProvider>
  );
}
/** The note under a row's words, found from its label. */
function noteOf(label: string): HTMLElement | null {
  const row = screen.getByText(label, { selector: '.setting__label > span' }).closest('.setting');
  return row?.querySelector<HTMLElement>('.setting__note') ?? null;
}
const set = <G extends 'appearance' | 'accessibility' | 'advanced'>(g: G, patch: Record<string, unknown>) =>
  act(() => usePrefs.getState().set(g, patch as never));

describe('Settings notes while an override is in force', () => {
  it('no notes when nothing overrides', () => {
    render(<AppearanceGroup />, { wrapper: Shell });
    expect(noteOf('Surfaces')).toBeNull();
    expect(noteOf('Film grain')).toBeNull();
    expect(noteOf('Gilt details')).toBeNull();
  });

  it('Transparency reduced: glass solid and grain off, linking to Accessibility', () => {
    render(<AppearanceGroup />, { wrapper: Shell });
    set('accessibility', { transparency: 'reduced' });
    expect(noteOf('Surfaces')).toHaveTextContent('Solid while Transparency is reduced.');
    expect(noteOf('Film grain')).toHaveTextContent('Off while Transparency is reduced.');
    expect(noteOf('Surfaces')?.querySelector('a')).toHaveAttribute('href', '/settings/accessibility');
    // Gilt is never overridden.
    expect(noteOf('Gilt details')).toBeNull();
  });

  it('the system reducing transparency', () => {
    render(<AppearanceGroup />, { wrapper: Shell });
    setOs({ transparency: true });
    expect(noteOf('Surfaces')).toHaveTextContent(
      'Solid while your system reduces transparency (see Transparency).',
    );
    expect(noteOf('Film grain')).toHaveTextContent('Off while your system reduces transparency');
  });

  it('Effects Light, linking to Advanced', () => {
    render(<AppearanceGroup />, { wrapper: Shell });
    set('advanced', { performance: 'lite' });
    expect(noteOf('Surfaces')).toHaveTextContent('Solid while Effects is Light.');
    expect(noteOf('Film grain')).toHaveTextContent('Off while Effects is Light.');
    expect(noteOf('Film grain')?.querySelector('a')).toHaveAttribute('href', '/settings/advanced');
  });

  it('Effects Automatic, while the machine is struggling, and back when it is not', () => {
    render(<AppearanceGroup />, { wrapper: Shell });
    act(() => usePrefs.getState().setAutoLite(true));
    expect(noteOf('Surfaces')).toHaveTextContent(
      'Solid for now: Effects turned blur off because the machine is struggling.',
    );
    expect(noteOf('Film grain')).toHaveTextContent(
      'Off for now: Effects turned it off because the machine is struggling.',
    );
    act(() => usePrefs.getState().setAutoLite(false));
    expect(noteOf('Surfaces')).toBeNull();
  });

  it('no note on a row whose own choice is already off', () => {
    render(<AppearanceGroup />, { wrapper: Shell });
    set('appearance', { material: 'solid', grain: false });
    set('accessibility', { transparency: 'reduced' });
    expect(noteOf('Surfaces')).toBeNull();
    expect(noteOf('Film grain')).toBeNull();
  });

  it('the overriding rows say what System and Automatic come to', () => {
    const { unmount } = render(<AccessibilityGroup />, { wrapper: Shell });
    expect(noteOf('Motion')).toBeNull();
    expect(noteOf('Transparency')).toBeNull();
    setOs({ motion: true, transparency: true });
    expect(noteOf('Motion')).toHaveTextContent('Reduced: your system asks for less motion.');
    expect(noteOf('Transparency')).toHaveTextContent('Reduced: your system asks for less transparency');
    // A choice of its own is not "System": no note.
    set('accessibility', { motion: 'full' });
    expect(noteOf('Motion')).toBeNull();
    unmount();

    render(<AdvancedGroup />, { wrapper: Shell });
    expect(noteOf('Effects')).toBeNull();
    act(() => usePrefs.getState().setAutoLite(true));
    expect(noteOf('Effects')).toHaveTextContent(
      'Light for now: blur and grain are off while the machine is struggling.',
    );
    set('advanced', { performance: 'full' });
    expect(noteOf('Effects')).toBeNull();
  });
});

describe('glass wins over the grounds of the components it is laid on', () => {
  const prefsCss = stripComments(read('../../../packages/aperture/src/prefs.css'));
  const glassRules = topRules(prefsCss).filter(
    (r) => /\.m-glass(-thick)?\b/.test(r.prelude) && /backdrop-filter:\s*blur/.test(r.body),
  );

  it('the glass recipe applies only while glass is in force', () => {
    expect(glassRules.length).toBe(2);
    for (const r of glassRules) {
      expect(r.prelude).toContain("[data-material='glass']");
      expect(r.prelude).toContain(":not([data-fx='lite'])");
    }
    // The plain classes carry no glass: Solid, reduced transparency and Light fall back to them.
    for (const r of topRules(prefsCss).filter((x) => /^\.m-glass(-thick)?$/.test(x.prelude)))
      expect(r.body).not.toMatch(/--glass|backdrop-filter/);
  });

  it('outweighs every component rule that sets a ground on an element marked glass', () => {
    const glassSpec = specificity(glassRules[0]?.prelude ?? '');
    // Which classes share an element with m-glass or m-glass-thick in the screens.
    const src = here('../src/');
    const marked = new Set<string>();
    for (const f of (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith('.tsx')))
      for (const m of readFileSync(src + f, 'utf8').matchAll(
        /className=["{`']([^"`'}]*\bm-glass(?:-thick)?\b[^"`'}]*)/g,
      ))
        for (const c of (m[1] ?? '').split(/\s+/))
          if (c && !c.startsWith('m-glass') && /^[\w-]+$/.test(c)) marked.add(c);
    expect(marked.has('dialog')).toBe(true);
    expect(marked.has('composer')).toBe(true);

    const styles = here('../src/styles/');
    const beaten: string[] = [];
    for (const f of readdirSync(styles).filter((f) => f.endsWith('.css'))) {
      const css = stripComments(readFileSync(styles + f, 'utf8'));
      // Rules inside @media blocks count too: walk one level down.
      const rules = topRules(css).concat(
        [...css.matchAll(/@media[^{]+\{([\s\S]*?)\n\}/g)].flatMap((m) => topRules(m[1] ?? '')),
      );
      for (const r of rules) {
        if (!/(^|[;\s])background(-color)?\s*:/.test(r.body)) continue;
        for (const sel of splitTop(r.prelude, ',')) {
          const subject =
            sel
              .split(/\s+|>|\+|~/)
              .filter(Boolean)
              .pop() ?? '';
          if (/::?(before|after)/.test(subject)) continue;
          const classes = [...subject.matchAll(/\.([\w-]+)/g)].map((m) => m[1] ?? '');
          if (!classes.some((c) => marked.has(c))) continue;
          const s = specificity(sel);
          const wins = s[0] > glassSpec[0] || (s[0] === glassSpec[0] && s[1] >= glassSpec[1]);
          if (wins) beaten.push(`${f}: ${sel} ${s.join(',')}`);
        }
      }
    }
    expect(beaten).toEqual([]);
  });

  it('every glass surface that draws its own glass turns solid with the rest', () => {
    const styles = here('../src/styles/');
    const own: string[] = [];
    for (const f of readdirSync(styles).filter((f) => f.endsWith('.css'))) {
      const css = stripComments(readFileSync(styles + f, 'utf8'));
      for (const r of topRules(css))
        if (/background:\s*var\(--glass(-thick)?\)/.test(r.body))
          for (const sel of splitTop(r.prelude, ',')) {
            const solid = new RegExp(
              `:root\\[data-material='solid'\\]\\s+${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,{]`,
            );
            const lite = new RegExp(
              `:root\\[data-fx='lite'\\]\\s+${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,{]`,
            );
            if (!solid.test(css) || !lite.test(css)) own.push(`${f}: ${sel}`);
          }
    }
    expect(own).toEqual([]);
  });

  it('glass lets the screen through: no more than 80% opaque', () => {
    for (const look of [
      { theme: 'dark' as const },
      { theme: 'light' as const },
      { theme: 'dark' as const, tint: 'ink' },
      { theme: 'dark' as const, tint: 'obsidian' },
    ]) {
      const t = tokensFor(look);
      expect(parse(t['--glass'])[3]).toBeLessThanOrEqual(0.7);
      expect(parse(t['--glass-thick'])[3]).toBeLessThanOrEqual(0.8);
    }
  });
});

describe('the grain shows on every ground', () => {
  const prefsCss = stripComments(read('../../../packages/aperture/src/prefs.css'));
  const grain = topRules(prefsCss).find((r) => r.prelude === '.grain')?.body ?? '';
  const blend = grain.match(/mix-blend-mode:\s*([\w-]+)/)?.[1] ?? 'normal';

  // The separable blend modes, per channel, 0..1 (Compositing and Blending 1).
  const B: Record<string, (b: number, s: number) => number> = {
    normal: (_b, s) => s,
    multiply: (b, s) => b * s,
    screen: (b, s) => b + s - b * s,
    overlay: (b, s) => B['hard-light']?.(s, b) ?? 0,
    'hard-light': (b, s) => (s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1)),
    'soft-light': (b, s) => {
      if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
      const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
      return b + (2 * s - 1) * (d - b);
    },
  };
  /** How far a grain speck moves a ground, in 0..255 steps, at the layer's opacity. */
  const speck = (ground: number, s: number, opacity: number) => {
    const f = B[blend];
    if (!f) throw new Error(`unknown blend ${blend}`);
    return (f(ground, s) - ground) * opacity * 255;
  };

  it('is grey noise at mid-grey (sRGB), so it neither tints nor veils the ground', () => {
    expect(grain).toContain("color-interpolation-filters='sRGB'");
    expect(grain).toContain('feColorMatrix');
    // Mid-grey changes nothing under the chosen blend.
    expect(Math.abs(speck(0.04, 0.5, 1))).toBeLessThan(0.5);
    expect(Math.abs(speck(0.92, 0.5, 1))).toBeLessThan(0.5);
  });

  it.each([
    ['dark', '--void'],
    ['dark', '--lift-3'],
    ['light', '--void-deep'],
    ['light', '--lift'],
  ] as const)('a speck a fifth off mid-grey moves the %s %s by at least 6 of 255', (theme, ground) => {
    const t = tokensFor({ theme, tint: theme === 'dark' ? 'obsidian' : undefined });
    const g = parse(t[ground]);
    const level = (0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2]) / 255;
    const opacity = Number(t['--grain-opacity']);
    const strongest = Math.max(Math.abs(speck(level, 0.7, opacity)), Math.abs(speck(level, 0.3, opacity)));
    expect(strongest).toBeGreaterThanOrEqual(6);
    // ...and never so strong that it reads as dirt (a sixth of the way to white or black).
    expect(strongest).toBeLessThan(255 / 6);
  });
});

describe('gilt On is a different thing from Subtle', () => {
  it.each(['dark', 'light'] as const)('in %s: a stronger wash, a brighter rim, a richer ink', (theme) => {
    const on = tokensFor({ theme, gilt: 'on' });
    const subtle = tokensFor({ theme, gilt: 'subtle' });
    expect(parse(on['--gilt-wash'])[3]).toBeGreaterThanOrEqual(2 * parse(subtle['--gilt-wash'])[3]);
    expect(parse(on['--gilt-line'])[3]).toBeGreaterThanOrEqual(2 * parse(subtle['--gilt-line'])[3]);
    const chroma = (c: string | undefined) => {
      const [, a, b] = oklab(parse(c));
      return Math.hypot(a, b);
    };
    // The brass is visibly more saturated with gilt On.
    expect(chroma(on['--gilt'])).toBeGreaterThan(1.5 * chroma(subtle['--gilt']));
  });

  it('off has no brass at all', () => {
    const off = tokensFor({ theme: 'dark', gilt: 'off' });
    expect(off['--gilt']).toBe(tokensFor({ theme: 'dark' })['--fg-3']);
    expect(off['--gilt-wash']).toBe(tokensFor({ theme: 'dark' })['--chalk']);
  });

  it('the app draws gilt grounds and rims with the tokens, so every mode reaches them', () => {
    const styles = here('../src/styles/');
    const faint: string[] = [];
    for (const f of readdirSync(styles).filter((f) => f.endsWith('.css') && f !== 'tools.css'))
      readFileSync(styles + f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // A gilt chip ground written by hand at 8-12% (it should be --gilt-wash).
          if (/background:\s*rgb\(var\(--gilt-rgb\)\s*\/\s*0\.(08|1|12)\)/.test(line))
            faint.push(`${f}:${i + 1}`);
        });
    // Diff lines keep their own quiet wash (code.css, memory.css): a ground for many lines, not a chip.
    expect(faint.filter((x) => !/^(code|memory)\.css:/.test(x))).toEqual([]);
  });
});
