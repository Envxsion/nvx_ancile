/**
 * ------------------------------------------------------------------
 *  Title    |  Request guard for the Cockpit API
 *  Ref      |  DESIGN.md §4.1, §5.8 · docs/api.md (Calling the API)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Two questions before any /api/v1 route runs. Is the
 *           |  caller the owner (a script with the install key, or a
 *           |  browser paired with it)? And, for a browser, is the
 *           |  request really from the Cockpit and not another site
 *           |  driving it (cross-site request forgery)? Core listens
 *           |  on localhost, so any process and any page the browser
 *           |  opens can reach it; only the owner may act or read.
 *  How      |  In order:
 *           |    1. the pairing route is open (its one-time code is the
 *           |       credential); nothing else is
 *           |    2. Sec-Fetch-Site: cross-site is refused
 *           |    3. an Origin header, when there is one, must be one of
 *           |       the Cockpit's
 *           |    4. a request must carry the install key (Bearer) or
 *           |       the session cookie (localAuth.ts), else 401
 *           |       auth.local_key_required
 *           |    5. a change (not GET, HEAD or OPTIONS) made with the
 *           |       cookie alone must name the Cockpit in Origin: a
 *           |       request with no Origin passes only with the key
 *           |    6. approvals, grants, permissions, scopes, privacy and
 *           |       the other routes that decide what an agent may do
 *           |       need the cookie; the key alone is refused (403
 *           |       auth.browser_session_required), and so is a change
 *           |       with no Origin
 *           |    7. a body must be JSON (multipart for uploads), which a
 *           |       plain HTML form cannot send without a CORS preflight
 *  Note     |  The check is on the request's own headers, never on the
 *           |  address it came from: another process on this machine
 *           |  comes from 127.0.0.1 too.
 * ------------------------------------------------------------------
 */

import { AncileError, BROWSER_SESSION_REQUIRED, LOCAL_KEY_REQUIRED } from '@nvx/contracts';
import type { MiddlewareHandler } from 'hono';
import { accessFor, isMutating, type LocalAuth } from './localAuth';

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

export const keyRequired = (detail?: string) =>
  new AncileError({
    code: LOCAL_KEY_REQUIRED,
    title: 'This browser or tool is not connected to NVX Ancile',
    ...(detail && { detail }),
    hint: 'In a browser, run `pnpm pair` in the NVX Ancile folder, or open the desktop app. A script sends its install key as `Authorization: Bearer <key>` (the key is in local-api.key in the data folder).',
    status: 401,
    errorClass: 'permanent',
  });

export const sessionRequired = (detail: string) =>
  new AncileError({
    code: BROWSER_SESSION_REQUIRED,
    title: 'Only the paired browser can do that',
    detail,
    hint: 'Answer approvals and change permissions, scopes or privacy in the NVX Ancile app. A script with the install key can read and work, but cannot answer for you.',
    status: 403,
    errorClass: 'permanent',
  });

export interface GuardOptions {
  origins: string[];
  /** Required: a guard with no way to tell the owner from another process would be a guard in name only. */
  auth: LocalAuth;
}

export function requestGuard(opts: GuardOptions): MiddlewareHandler {
  const allowed = new Set(opts.origins);
  const { auth } = opts;
  return async (c, next) => {
    const access = accessFor(c.req.method, c.req.path);
    // The pairing route: a top-level navigation, so no Origin to check; the one-time code is the credential.
    if (access === 'open') return next();

    const mutating = isMutating(c.req.method);
    const origin = c.req.header('origin');
    if (c.req.header('sec-fetch-site') === 'cross-site') throw crossOrigin('Sec-Fetch-Site is cross-site.');
    if (origin !== undefined && !allowed.has(origin))
      throw crossOrigin(`Origin ${origin} is not the Cockpit.`);

    const presented = auth.inspect({
      authorization: c.req.header('authorization'),
      cookie: c.req.header('cookie'),
    });
    if (!presented.bearer && !presented.cookie) {
      throw keyRequired(
        c.req.header('authorization')
          ? "The key sent in Authorization is not this install's key."
          : 'No key or browser session came with this request.',
      );
    }
    if (access === 'key' && !presented.bearer)
      throw keyRequired('This route takes the install key, not a browser session.');
    // A browser always says where a change comes from; a request that does not is a script, and a script needs the key.
    if (mutating && origin === undefined && !presented.bearer)
      throw crossOrigin('A change made with the browser session must name the Cockpit in Origin.');
    if (access === 'session') {
      if (!presented.cookie)
        throw sessionRequired('This route needs the browser session; the install key alone is not enough.');
      if (mutating && origin === undefined)
        throw sessionRequired('A change to this needs the browser session and an Origin from the Cockpit.');
    }

    if (mutating) {
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
    }
    c.set('presented', presented);
    return next();
  };
}
