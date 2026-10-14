/**
 * Read APERTURE's token CSS the way the browser would, for tests: the
 * custom properties <html> gets for a set of data-* attributes (cascade by
 * specificity, then source order; var() resolved), plus the colour maths
 * WCAG uses (sRGB compositing, relative luminance, contrast ratio) and the
 * oklab mix color-mix() draws. Used by contrast.test.ts and materials.test.tsx.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const APERTURE = '../../../packages/aperture/src/';
export const STYLES = '../src/styles/';
/** A path relative to this test folder (import.meta.url is not a file: URL in a .tsx test). */
export const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
export const read = (rel: string) => readFileSync(here(rel), 'utf8');

// ---- The cascade, for rules on the root element -------------------------

export interface Decl {
  sel: string;
  spec: [number, number, number];
  order: number;
  props: Record<string, string>;
}

/** Comments blanked out, line breaks kept (so line numbers still point at the source). */
export const stripComments = (css: string) =>
  css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

/** Top-level rules only: @media, @font-face and @keyframes hold no colour tokens. */
export function topRules(css: string): { prelude: string; body: string }[] {
  const out: { prelude: string; body: string }[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    if (!prelude.startsWith('@')) out.push({ prelude, body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

/** Split on a separator outside parentheses. */
export function splitTop(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function specificity(sel: string): [number, number, number] {
  let a = 0;
  let b = 0;
  let c = 0;
  let s = sel.replace(/:(is|not|has|where)\(((?:[^()]|\([^()]*\))*)\)/g, (_, fn: string, args: string) => {
    if (fn === 'where') return ' ';
    const best = splitTop(args, ',')
      .map(specificity)
      .sort((x, y) => y[0] - x[0] || y[1] - x[1] || y[2] - x[2])[0] ?? [0, 0, 0];
    a += best[0];
    b += best[1];
    c += best[2];
    return ' ';
  });
  s = s.replace(/\[[^\]]*\]/g, () => {
    b++;
    return ' ';
  });
  s = s.replace(/#[\w-]+/g, () => {
    a++;
    return ' ';
  });
  s = s.replace(/\.[\w-]+/g, () => {
    b++;
    return ' ';
  });
  s = s.replace(/::[\w-]+/g, () => {
    c++;
    return ' ';
  });
  s = s.replace(/:[\w-]+/g, () => {
    b++;
    return ' ';
  });
  s = s.replace(/[a-zA-Z][\w-]*/g, () => {
    c++;
    return ' ';
  });
  return [a, b, c];
}

const DECLS: Decl[] = [];
{
  let order = 0;
  for (const file of ['tokens.css', 'ancile.css', 'prefs.css', 'pro.css']) {
    for (const r of topRules(stripComments(read(APERTURE + file)))) {
      const props: Record<string, string> = {};
      for (const d of splitTop(r.body, ';')) {
        const m = d.match(/^(--[\w-]+)\s*:\s*([\s\S]+)$/);
        if (m?.[1] && m[2]) props[m[1]] = m[2].trim().replace(/\s+/g, ' ');
      }
      if (!Object.keys(props).length) continue;
      for (const sel of splitTop(r.prelude, ',')) {
        // Only selectors whose subject is the root element itself.
        if (/[\s>+~]/.test(sel.replace(/\([^)]*\)/g, ''))) continue;
        DECLS.push({ sel, spec: specificity(sel), order: order++, props });
      }
    }
  }
}

export type Look = {
  theme: 'dark' | 'light';
  tint?: string;
  accent?: string;
  contrast?: string;
  gilt?: string;
  edition?: string;
};

/** The custom properties <html> gets for these data-* attributes, var() resolved. */
export function tokensFor(look: Look): Record<string, string> {
  const root = document.documentElement;
  for (const a of [...root.attributes]) if (a.name.startsWith('data-')) root.removeAttribute(a.name);
  for (const [k, v] of Object.entries(look)) if (v) root.setAttribute(`data-${k}`, v);
  const hits = DECLS.filter((d) => root.matches(d.sel)).sort(
    (x, y) => x.spec[0] - y.spec[0] || x.spec[1] - y.spec[1] || x.spec[2] - y.spec[2] || x.order - y.order,
  );
  for (const a of [...root.attributes]) if (a.name.startsWith('data-')) root.removeAttribute(a.name);
  const raw: Record<string, string> = {};
  for (const h of hits) Object.assign(raw, h.props);
  const done: Record<string, string> = {};
  const value = (name: string, seen: string[] = []): string | undefined => {
    if (name in done) return done[name];
    if (seen.includes(name)) throw new Error(`var() cycle: ${[...seen, name].join(' → ')}`);
    const v = raw[name];
    if (v === undefined) return undefined;
    const out = substitute(v, [...seen, name]);
    done[name] = out;
    return out;
  };
  const substitute = (v: string, seen: string[]): string => {
    let s = v;
    for (let at = s.indexOf('var('); at >= 0; at = s.indexOf('var(')) {
      let depth = 0;
      let end = at + 3;
      for (; end < s.length; end++) {
        if (s[end] === '(') depth++;
        else if (s[end] === ')' && --depth === 0) break;
      }
      const [ref = '', ...fb] = splitTop(s.slice(at + 4, end), ',');
      const got = value(ref.trim(), seen) ?? (fb.length ? substitute(fb.join(','), seen) : '');
      s = s.slice(0, at) + got + s.slice(end + 1);
    }
    return s;
  };
  for (const k of Object.keys(raw)) value(k);
  return done;
}

// ---- Colour --------------------------------------------------------------

export type RGBA = [number, number, number, number];

export function parse(s: string | undefined): RGBA {
  const v = (s ?? '').trim();
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex?.[1]) {
    const h = hex[1].length === 3 ? [...hex[1]].map((x) => x + x).join('') : hex[1];
    return [
      Number.parseInt(h.slice(0, 2), 16),
      Number.parseInt(h.slice(2, 4), 16),
      Number.parseInt(h.slice(4, 6), 16),
      1,
    ];
  }
  const rgb = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+)(%?))?\s*\)$/);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]) / (rgb[5] ? 100 : 1);
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha];
  }
  throw new Error(`not a colour: "${v}"`);
}

/** Source-over, in sRGB as browsers paint. */
export const over = (fg: RGBA, bg: RGBA): RGBA => [
  fg[0] * fg[3] + bg[0] * (1 - fg[3]),
  fg[1] * fg[3] + bg[1] * (1 - fg[3]),
  fg[2] * fg[3] + bg[2] * (1 - fg[3]),
  1,
];
export const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
export const luminance = (c: RGBA) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export function contrast(a: RGBA, b: RGBA): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** OKLab [L, a, b] of an sRGB colour. */
export function oklab(c: RGBA): [number, number, number] {
  const [r, g, bl] = [lin(c[0]), lin(c[1]), lin(c[2])];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** color-mix(in oklab, a p, b): what the ramp-as-text rule draws. */
export function mixOklab(a: RGBA, b: RGBA, p: number): RGBA {
  const A = oklab(a);
  const B = oklab(b);
  const [L, x, y] = A.map((v, i) => v * p + (B[i] ?? 0) * (1 - p)) as [number, number, number];
  const l = (L + 0.3963377774 * x + 0.2158037573 * y) ** 3;
  const m = (L - 0.1055613458 * x - 0.0638541728 * y) ** 3;
  const s = (L - 0.0894841775 * x - 1.291485548 * y) ** 3;
  const enc = (v: number) => {
    const c = Math.min(1, Math.max(0, v));
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  };
  return [
    enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    1,
  ];
}
