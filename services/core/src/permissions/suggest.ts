/**
 * ------------------------------------------------------------------
 *  Title    |  Pattern suggestions
 *  Ref      |  DESIGN.md §5.4
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  When Ancile asks, it offers a ladder from "this exact
 *           |  thing" to "everything like it", narrowest first, so one
 *           |  approval can cover the obvious follow-ups without the
 *           |  user writing a glob.
 *  Note     |  Never suggests wider than the workspace root for files,
 *           |  or wider than one host for URLs.
 * ------------------------------------------------------------------
 */

import { posix } from 'node:path';
import { isWithin, scheme } from './normalize';

export function suggestPatterns(resource: string, opts: { workspaceRoot: string; max?: number }): string[] {
  const max = opts.max ?? 4;
  const s = scheme(resource);
  const rest = resource.slice(s.length + 1);
  const out: string[] = [resource];

  if (s === 'fs') {
    const root = posix.normalize(opts.workspaceRoot);
    let dir = posix.dirname(rest);
    while (isWithin(dir, root)) {
      out.push(`fs:${dir === '/' ? '' : dir}/**`);
      if (dir === root) break;
      dir = posix.dirname(dir);
    }
  } else if (s === 'http') {
    try {
      const u = new URL(rest);
      const segs = u.pathname.split('/').filter(Boolean);
      for (let n = segs.length - 1; n >= 0; n--) {
        out.push(`http:${u.origin}/${segs.slice(0, n).join('/')}${n ? '/' : ''}**`);
      }
    } catch {
      /* not a URL: only the exact resource */
    }
  } else if (s === 'mcp') {
    const server = rest.split('/')[0];
    if (server) out.push(`mcp:${server}/*`);
  } else if (s === 'shell') {
    const cmd = rest.split(' ')[0];
    if (cmd && cmd !== rest) out.push(`shell:${cmd} *`);
  }

  return [...new Set(out)].slice(0, max);
}
