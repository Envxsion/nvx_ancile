/**
 * ------------------------------------------------------------------
 *  Title    |  Grant patterns
 *  Ref      |  docs/permissions.md#patterns · DESIGN.md §5.4
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  One matcher for what a remembered answer covers, shared
 *           |  by Core (which decides) and the cockpit (which shows
 *           |  "this pattern matches the current request" before you
 *           |  save it), so the two can never disagree.
 *  How      |  Globs: `*` is one segment, `**` is any depth (including
 *           |  none). Actions use "." as the separator, resources "/".
 *           |  A trailing "/**" also matches the directory itself.
 *           |  Two schemes read differently:
 *           |    shell:  a wildcard matches any text, slashes included,
 *           |            but never ; & | ` $ < > or a line break, so
 *           |            `git status*` cannot cover `git status; rm …`.
 *           |    web:    a site rule, not a glob over text (below). It
 *           |            covers searches (web:search/<query>) and
 *           |            fetches (http:<url>); its grant's action is web.*.
 *           |  web:*                 every search and every website
 *           |  web:search            every web search
 *           |  web:fetch             every fetch, any website
 *           |  web:example.com       pages on example.com only
 *           |  web:*.example.com     example.com and any subdomain
 *           |  web:example.com/docs/**  that path and below
 *           |  web:search/<query>    that one search, exactly
 *  Note     |  Pure and dependency-free: the cockpit bundles it.
 * ------------------------------------------------------------------
 */

const cache = new Map<string, RegExp>();

const escapeRe = (s: string) => s.replace(/[.+^${}()|[\]\\?*]/g, '\\$&');

/** Characters a shell wildcard never matches: they chain, substitute or redirect. */
const SHELL_META = ';&|`$<>\\n\\r';

export function compileGlob(pattern: string, sep: '/' | '.', mode: 'path' | 'shell' = 'path'): RegExp {
  const key = `${mode}\u0000${sep}\u0000${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const s = escapeRe(sep);
  let re = '';
  let i = 0;
  if (mode === 'shell') {
    const any = `[^${SHELL_META}]*`;
    while (i < pattern.length) {
      if (pattern[i] === '*') {
        re += any;
        while (pattern[i] === '*') i += 1;
      } else {
        re += escapeRe(pattern[i] as string);
        i += 1;
      }
    }
  } else {
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
  }
  const compiled = new RegExp(`^${re}$`);
  if (cache.size > 5000) cache.clear();
  cache.set(key, compiled);
  return compiled;
}

export function matchGlob(pattern: string, value: string, sep: '/' | '.'): boolean {
  return compileGlob(pattern, sep).test(value);
}

const schemeOf = (resource: string): string => {
  const i = resource.indexOf(':');
  return i > 0 ? resource.slice(0, i) : '';
};

/** Is this a site rule (web:…), which covers searches and fetches alike? */
export const isWebPattern = (pattern: string): boolean => pattern.startsWith('web:');

/** The action a remembered pattern covers: a site rule covers web.search and web.fetch. */
export const grantActionFor = (pattern: string, askedAction: string): string =>
  isWebPattern(pattern) ? 'web.*' : askedAction;

function hostMatches(spec: string, u: URL): boolean {
  if (!spec) return false;
  const host = spec.includes(':') ? u.host : u.hostname;
  if (spec.startsWith('*.')) {
    const base = spec.slice(2);
    if (!base || base.includes('*')) return false;
    return host === base || host.endsWith(`.${base}`);
  }
  if (spec.includes('*')) return false;
  return host === spec;
}

/** A site rule (the part after "web:") against a search or a fetch. */
export function matchWeb(spec: string, resource: string): boolean {
  const s = schemeOf(resource);
  if (s === 'web') {
    // A search: web:search/<query> (web:<query> before October 2026).
    const rest = resource.slice(4);
    const query = rest.startsWith('search/') ? rest.slice(7) : rest;
    return spec === '*' || spec === 'search' || spec === `search/${query}`;
  }
  if (s !== 'http') return false;
  let u: URL;
  try {
    u = new URL(resource.slice(5));
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (spec === '*' || spec === 'fetch') return true;
  if (spec === 'search' || spec.startsWith('search/')) return false;
  const slash = spec.indexOf('/');
  const hostSpec = (slash < 0 ? spec : spec.slice(0, slash)).toLowerCase();
  if (!hostMatches(hostSpec, u)) return false;
  return slash < 0 || matchGlob(spec.slice(slash), u.pathname, '/');
}

export const matchAction = (pattern: string, action: string) => matchGlob(pattern, action, '.');

export function matchResource(pattern: string, resource: string): boolean {
  if (isWebPattern(pattern)) return matchWeb(pattern.slice(4), resource);
  if (schemeOf(pattern) === 'shell' && schemeOf(resource) === 'shell')
    return compileGlob(pattern, '/', 'shell').test(resource);
  return matchGlob(pattern, resource, '/');
}

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

/**
 * Does the site rule `next` cover only what `granted` covers? Used when a
 * grant is edited (an edit may only narrow).
 */
export function webPatternNarrows(granted: string, next: string): boolean {
  if (!isWebPattern(granted) || !isWebPattern(next)) return false;
  const g = granted.slice(4);
  const n = next.slice(4);
  if (g === n || g === '*') return true;
  if (g === 'search') return n.startsWith('search/');
  if (n === '*' || n === 'search' || n === 'fetch' || n.startsWith('search/')) return false;
  // A site rule as a sample address: every wildcard filled with a placeholder.
  const slash = n.indexOf('/');
  const host = (slash < 0 ? n : n.slice(0, slash)).replace(/^\*\./, 'x.');
  const path = slash < 0 ? '/' : n.slice(slash).replace(/\*\*/g, 'x/x').replace(/\*/g, 'x');
  if (host.includes('*') || !host) return false;
  const sample = `http:https://${host}${path}`;
  if (g === 'fetch') return true;
  if (!matchWeb(g, sample)) return false;
  // A bare-host sample hides a subdomain wildcard: *.a.com is wider than a.com.
  if (n.startsWith('*.') && !g.startsWith('*.')) return false;
  // Below a path, n may not bring in a ** that g lacks (a/* is not a/**).
  return !g.includes('/') || !n.includes('**') || g.includes('**');
}
