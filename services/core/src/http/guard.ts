/**
 * ------------------------------------------------------------------
 *  Title    |  Request guard for the Cockpit API
 *  Ref      |  DESIGN.md §4.1, §5.8
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Stop another web page from driving /api/v1 through the
 *           |  person's browser (cross-site request forgery). Core
 *           |  listens on localhost, so any page the browser opens can
 *           |  reach it; only the Cockpit should be able to act.
 *  How      |  On a request that changes something (not GET, HEAD or
 *           |  OPTIONS):
 *           |    - Sec-Fetch-Site: cross-site is refused
 *           |    - an Origin header must be one of the Cockpit's
 *           |    - a body must be JSON (multipart for uploads), which a
 *           |      plain HTML form cannot send without a CORS preflight
 *           |  A request without Origin (curl, another service) passes.
 *           |  TODO(phase-5): require the local session once the
 *           |  passphrase login exists, and drop the no-Origin pass.
 * ------------------------------------------------------------------
 */

import { AncileError } from '@nvx/contracts';
import type { MiddlewareHandler } from 'hono';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const BODY_TYPES = ['application/json', 'multipart/form-data'];

/** Where the Cockpit runs: the dev server, Core itself in production, and the desktop app. */
export function cockpitOrigins(publicUrl?: string, extra: string[] = []): string[] {
  const out = new Set([
    'http://localhost:7701',
    'http://127.0.0.1:7701',
    'http://localhost:7700',
    'http://127.0.0.1:7700',
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
  ]);
  if (publicUrl) {
    try {
      out.add(new URL(publicUrl).origin);
    } catch {
      /* the environment check already rejects a bad URL */
    }
  }
  for (const o of extra) if (o.trim()) out.add(o.trim().replace(/\/+$/, ''));
  return [...out];
}

const crossOrigin = (detail: string) =>
  new AncileError({
    code: 'request.cross_origin',
    title: 'This request came from another site',
    detail,
    hint: 'Open NVX Ancile from its own address. If you serve the Cockpit elsewhere, add that origin to ANCILE_ALLOWED_ORIGINS.',
    status: 403,
    errorClass: 'permanent',
  });

export function requestGuard(opts: { origins: string[] }): MiddlewareHandler {
  const allowed = new Set(opts.origins);
  return async (c, next) => {
    if (SAFE.has(c.req.method)) return next();

    if (c.req.header('sec-fetch-site') === 'cross-site') throw crossOrigin('Sec-Fetch-Site is cross-site.');
    const origin = c.req.header('origin');
    if (origin !== undefined && !allowed.has(origin))
      throw crossOrigin(`Origin ${origin} is not the Cockpit.`);

    const length = c.req.header('content-length');
    const hasBody =
      (length !== undefined && length !== '0') || c.req.header('transfer-encoding') !== undefined;
    if (hasBody) {
      const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (!BODY_TYPES.includes(type)) {
        throw new AncileError({
          code: 'request.unsupported_type',
          title: 'Ancile only accepts JSON here',
          detail: `The body was sent as ${type || 'no content type'}.`,
          hint: 'Send the body as application/json with a matching Content-Type header.',
          status: 415,
          errorClass: 'permanent',
        });
      }
    }
    return next();
  };
}
