/**
 * ------------------------------------------------------------------
 *  Title    |  Grant patterns
 *  Ref      |  DESIGN.md §5.4
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  `*` is one segment, `**` is any depth (including none).
 *           |  Actions use "." as the separator, resources use "/".
 *  How      |  Compiled to an anchored RegExp and cached. A trailing
 *           |  "/**" also matches the directory itself, so a grant on
 *           |  /workspace/** covers listing /workspace.
 * ------------------------------------------------------------------
 */

const cache = new Map<string, RegExp>();

const escapeRe = (s: string) => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&');

export function compileGlob(pattern: string, sep: '/' | '.'): RegExp {
  const key = `${sep}\u0000${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const s = escapeRe(sep);
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith(`${sep}**`, i) && (i + 3 === pattern.length || pattern[i + 3] === sep)) {
      re += `(?:${s}.*)?`;
      i += 3;
    } else if (pattern.startsWith('**', i)) {
      re += '.*';
      i += 2;
    } else if (pattern[i] === '*') {
      re += `[^${s}]*`;
      i += 1;
    } else {
      re += escapeRe(pattern[i] as string);
      i += 1;
    }
  }
  const compiled = new RegExp(`^${re}$`);
  if (cache.size > 5000) cache.clear();
  cache.set(key, compiled);
  return compiled;
}

export function matchGlob(pattern: string, value: string, sep: '/' | '.'): boolean {
  return compileGlob(pattern, sep).test(value);
}

export const matchAction = (pattern: string, action: string) => matchGlob(pattern, action, '.');
export const matchResource = (pattern: string, resource: string) => matchGlob(pattern, resource, '/');

/**
 * How specific a pattern is: literal characters count, wildcards cost.
 * Used for "most specific grant wins".
 */
export function specificity(pattern: string): number {
  const literals = pattern.replace(/\*+/g, '').length;
  const doubles = (pattern.match(/\*\*/g) ?? []).length;
  const singles = (pattern.replace(/\*\*/g, '').match(/\*/g) ?? []).length;
  return literals * 4 - doubles * 3 - singles;
}
