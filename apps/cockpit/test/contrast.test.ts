/**
 * Every text token holds 4.5:1 (WCAG 2.2 AA, 1.4.3) on every surface it is
 * set on, in every look that changes text or grounds: dark and light, each
 * dark ground tint, each accent, standard and high contrast, each gilt mode,
 * and the free and Pro editions.
 *
 * Nothing is copied here: the test reads the token CSS itself (tokens.css,
 * ancile.css, prefs.css, pro.css), works out the custom properties the
 * browser would give <html> for each combination of data-* attributes (the
 * cascade by specificity, then order), resolves var() and measures.
 *
 * Surfaces: the seven grounds (--void, --void-deep, --chrome, --lift,
 * --lift-2, --lift-3, --panel); the two glass materials over the grounds
 * they float on; and the chips text sits on: a state, accent or gilt ink on
 * a wash of its own colour (12%, the strongest wash the app puts under its
 * own ink; gilt uses --gilt-wash for its mode).
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  contrast,
  type Look,
  mixOklab,
  over,
  parse,
  type RGBA,
  read,
  STYLES,
  stripComments,
  tokensFor,
} from './tokenCss';

// ---- The looks -------------------------------------------------------------

const ACCENTS = ['ultraviolet', 'iris', 'orchid', 'rose', 'ember', 'jade', 'graphite'];
const LOOKS: Look[] = [];
for (const theme of ['dark', 'light'] as const)
  for (const tint of theme === 'dark' ? ['graphite', 'ink', 'obsidian'] : ['graphite'])
    for (const accent of ACCENTS)
      for (const contrastPref of ['standard', 'high'])
        for (const gilt of ['on', 'subtle', 'off'])
          for (const edition of [undefined, 'pro'])
            LOOKS.push({ theme, tint, accent, contrast: contrastPref, gilt, edition });

const name = (l: Look) =>
  `${l.theme}/${l.tint}/${l.accent}/${l.contrast}/gilt-${l.gilt}/${l.edition ?? 'free'}`;
const RESOLVED = LOOKS.map((look) => ({ look, t: tokensFor(look) }));

const GROUNDS = ['--void', '--void-deep', '--chrome', '--lift', '--lift-2', '--lift-3', '--panel'];
const TEXT = ['--fg', '--fg-2', '--fg-3', '--mute', '--mute-2', '--placeholder'];
const INKS = ['--signal-ink', '--ok', '--warn', '--fail', '--gilt'];
/** The strongest wash the app lays under its own ink (a status or accent chip). */
const CHIP = 0.12;
const AA = 4.5;

/** Every surface text sits on in this look, by name. */
function surfaces(t: Record<string, string>): [string, RGBA][] {
  const out: [string, RGBA][] = GROUNDS.map((g) => [g, parse(t[g])]);
  // Glass floats over the void and over content; blur averages what is behind.
  for (const glass of ['--glass', '--glass-thick'])
    for (const behind of ['--void', '--lift'])
      out.push([`${glass} over ${behind}`, over(parse(t[glass]), parse(t[behind]))]);
  return out;
}

function failures(check: (t: Record<string, string>) => [string, number][]): string[] {
  const out = new Set<string>();
  for (const { look, t } of RESOLVED)
    for (const [what, ratio] of check(t))
      if (ratio < AA) out.add(`${name(look)}: ${what} ${ratio.toFixed(2)}`);
  return [...out];
}

describe('the resolver reads the token CSS as the browser would', () => {
  it('finds the variant blocks (else every other check here would pass on the defaults)', () => {
    const t = (l: Look) => tokensFor(l);
    expect(t({ theme: 'dark' })['--fg']).toBe('#eff0ea');
    expect(t({ theme: 'light' })['--fg']).toBe('#0e1114');
    expect(t({ theme: 'dark', tint: 'obsidian' })['--void']).toBe('#050505');
    expect(t({ theme: 'light', tint: 'obsidian' })['--void']).toBe('#eceef0'); // tints are dark-only
    expect(t({ theme: 'light', accent: 'ember' })['--signal-ink']).toBe('#a33408');
    expect(t({ theme: 'dark', contrast: 'high' })['--mute']).toBe('#b4b8bc');
    expect(t({ theme: 'dark', edition: 'pro' })['--signal-ink']).toBe('#c2b4ff');
    expect(t({ theme: 'dark', edition: 'pro', accent: 'ultraviolet' })['--signal-ink']).toBe('#c2b4ff');
    expect(t({ theme: 'dark', edition: 'pro', accent: 'jade' })['--signal-ink']).toBe('#79e2b6');
    expect(t({ theme: 'dark', edition: 'pro', contrast: 'high' })['--mute-2']).toBe('#c6cacd');
    expect(t({ theme: 'light', gilt: 'subtle' })['--gilt']).toBe('#735e3a');
    expect(t({ theme: 'dark', gilt: 'off' })['--gilt']).toBe('#b4b8bc');
    expect(t({ theme: 'dark', gilt: 'subtle' })['--gilt-wash']).toBe('rgb(179 160 124 / 0.06)');
    expect(t({ theme: 'dark', edition: 'pro' })['--gilt-wash']).toBe('rgb(230 199 132 / 0.12)');
  });

  it('measures as WCAG does', () => {
    expect(contrast(parse('#000000'), parse('#ffffff'))).toBeCloseTo(21, 5);
    expect(contrast(parse('#777777'), parse('#ffffff'))).toBeCloseTo(4.48, 2);
    expect(contrast(over(parse('rgb(255 255 255 / 0.5)'), parse('#000')), parse('#000'))).toBeGreaterThan(5);
  });
});

describe('text tokens hold 4.5:1', () => {
  it('text and quiet text, placeholders too, on every ground and on glass', () => {
    expect(
      failures((t) =>
        surfaces(t).flatMap(([s, bg]) =>
          TEXT.map((x): [string, number] => [`${x} on ${s}`, contrast(over(parse(t[x]), bg), bg)]),
        ),
      ),
    ).toEqual([]);
  });

  it('accent, state and gilt inks on every ground and on glass', () => {
    expect(
      failures((t) =>
        surfaces(t).flatMap(([s, bg]) =>
          INKS.map((x): [string, number] => [`${x} on ${s}`, contrast(parse(t[x]), bg)]),
        ),
      ),
    ).toEqual([]);
  });

  it('each ink on a chip of its own colour', () => {
    const wash: Record<string, (t: Record<string, string>) => RGBA> = {
      '--signal-ink': (t) => parse(`rgb(${t['--signal-rgb']} / ${CHIP})`),
      '--ok': (t) => parse(`rgb(${t['--ok-rgb']} / ${CHIP})`),
      '--warn': (t) => parse(`rgb(${t['--warn-rgb']} / ${CHIP})`),
      '--fail': (t) => parse(`rgb(${t['--fail-rgb']} / ${CHIP})`),
      '--gilt': (t) => parse(t['--gilt-wash']),
    };
    expect(
      failures((t) =>
        GROUNDS.flatMap((g) =>
          INKS.map((x): [string, number] => {
            const bg = over(wash[x]?.(t) ?? [0, 0, 0, 0], parse(t[g]));
            return [`${x} chip on ${g}`, contrast(parse(t[x]), bg)];
          }),
        ),
      ),
    ).toEqual([]);
  });

  it('text on the fills: the primary button and the gilt pill', () => {
    expect(
      failures((t) => {
        const on = parse(t['--on-signal']);
        const out: [string, number][] = [
          ['--on-signal on --signal', contrast(on, parse(t['--signal']))],
          ['--on-signal on --signal-mid (pressed)', contrast(on, parse(t['--signal-mid']))],
          // The primary button is lit from above (base.css): white from 18% at
          // the top edge to none at 55%, so about 8% where the capitals start.
          [
            '--on-signal on the lit top of --signal',
            contrast(on, over(parse('rgb(255 255 255 / 0.08)'), parse(t['--signal']))),
          ],
        ];
        const stops = (t['--gilt-fill'] ?? '').match(/#[0-9a-f]{6}/gi) ?? [];
        for (const stop of stops)
          out.push([`--on-gilt on gilt fill ${stop}`, contrast(parse(t['--on-gilt']), parse(stop))]);
        return out;
      }),
    ).toEqual([]);
  });

  it('the identity ramp, where it is text, at --ramp-ink', () => {
    const RAMP = ['coral', 'amber', 'jade', 'cyan', 'azure', 'violet', 'magenta', 'chalk'].map(
      (h) => `--s-${h}`,
    );
    expect(
      failures((t) => {
        const p = Number.parseFloat(t['--ramp-ink'] ?? '100') / 100;
        return GROUNDS.flatMap((g) =>
          RAMP.map((h): [string, number] => [
            `${h} as text on ${g}`,
            contrast(mixOklab(parse(t[h]), parse(t['--fg']), p), parse(t[g])),
          ]),
        );
      }),
    ).toEqual([]);
  });
});

describe('quiet tokens that are not for text stay off text', () => {
  // tools.css belongs to another change in flight; its two line-number rules
  // move to --mute-2 with it.
  const PENDING = new Set<string>();
  const sheets = readdirSync(fileURLToPath(new URL(STYLES, import.meta.url))).filter(
    (f) => f.endsWith('.css') && !PENDING.has(f),
  );

  it('--mute-3 (rules, dots, gutters: under 3.5:1) is never a text colour', () => {
    const uses = sheets.flatMap((f) =>
      stripComments(read(STYLES + f))
        .split('\n')
        .map((line, i) => [line, i] as const)
        .filter(([line]) => /(^|[\s;{])color:\s*var\(--mute-3\)/.test(line))
        .map(([, i]) => `${f}:${i + 1}`),
    );
    expect(uses).toEqual([]);
  });

  it('the light fill --signal is never a text colour (text takes --signal-ink)', () => {
    const uses = sheets.flatMap((f) =>
      stripComments(read(STYLES + f))
        .split('\n')
        .map((line, i) => [line, i] as const)
        .filter(([line]) => /(^|[\s;{])color:\s*var\(--signal\)/.test(line))
        .map(([, i]) => `${f}:${i + 1}`),
    );
    expect(uses).toEqual([]);
  });
});
