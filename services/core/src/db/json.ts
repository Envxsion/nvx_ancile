/**
 * ------------------------------------------------------------------
 *  Title    |  Safe jsonb values
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Postgres jsonb refuses the NUL character and lone UTF-16
 *           |  surrogates. A model delta, a tool result or a file
 *           |  preview can carry either, and one bad character must not
 *           |  fail the write that holds a whole answer.
 *  How      |  pgSafe() walks a value and returns a copy with NUL
 *           |  removed and every lone surrogate replaced by U+FFFD.
 *           |  Keys are cleaned too. Every Pg store passes jsonb
 *           |  through it before sql.json().
 * ------------------------------------------------------------------
 */

const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** True when a string has a NUL or a lone surrogate. */
export function hasBadText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) return true;
    if (isHigh(c)) {
      if (!isLow(s.charCodeAt(i + 1))) return true;
      i++;
    } else if (isLow(c)) return true;
  }
  return false;
}

export function cleanText(s: string): string {
  if (!hasBadText(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) continue;
    if (isHigh(c) && isLow(s.charCodeAt(i + 1))) {
      out += s[i] + (s[i + 1] as string);
      i++;
    } else if (isHigh(c) || isLow(c)) out += REPLACEMENT;
    else out += s[i];
  }
  return out;
}

/** True when a string contains the NUL character. */
export const hasNul = (s: string) => s.includes(NUL);

/** A copy of `value` that Postgres will accept as jsonb. */
export function pgSafe<T>(value: T): T {
  return clean(value) as T;
}

function clean(v: unknown): unknown {
  if (typeof v === 'string') return cleanText(v);
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clean);
  // Dates and the like serialise themselves.
  if (typeof (v as { toJSON?: unknown }).toJSON === 'function') return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === undefined) continue;
    out[cleanText(k)] = clean(val);
  }
  return out;
}
