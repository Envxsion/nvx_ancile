/**
 * ------------------------------------------------------------------
 *  Title    |  The Cockpit's page header
 *  Ref      |  packages/contracts/src/csp.ts · docs/desktop.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Add to every page of the built Cockpit what its <meta>
 *           |  policy cannot say: no other page may frame it, and its
 *           |  frames may load the frame host's exact URL and nothing
 *           |  else. The frame host itself is sandboxed by header too,
 *           |  so even opened on its own it has an opaque origin.
 *  How      |  After the static handler answers, on HTML only. The
 *           |  header adds to the <meta> policy; it never loosens it.
 * ------------------------------------------------------------------
 */

import { cockpitHeaderCsp } from '@nvx/contracts';
import type { MiddlewareHandler } from 'hono';

export function cockpitPageHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (!(c.res.headers.get('content-type') ?? '').startsWith('text/html')) return;
    const csp = cockpitHeaderCsp(c.req.path, c.req.header('host'));
    if (csp) c.res.headers.set('content-security-policy', csp);
    c.res.headers.set('x-content-type-options', 'nosniff');
  };
}
