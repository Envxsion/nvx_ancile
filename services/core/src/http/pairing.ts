/**
 * ------------------------------------------------------------------
 *  Title    |  Pairing a browser with this install
 *  Ref      |  DESIGN.md §4.1 · docs/api.md (Calling the API)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A browser has no way to read the install key (and must
 *           |  not be given it). Pairing turns a script's proof of the
 *           |  key into a browser session, without the key ever
 *           |  appearing in an address bar, a history or a log.
 *  How      |  POST /session/pair-codes (install key only) returns a
 *           |  one-time code, good for 60 seconds. `pnpm pair` and the
 *           |  desktop app open GET /session/pair?code=… in the
 *           |  browser; Core spends the code, sets the session cookie
 *           |  (HttpOnly, SameSite=Strict, 400 days) and answers 303 to
 *           |  `next` (a path on this site) or `/`. A code that is
 *           |  wrong, spent or too old answers 303 to `/?pair=failed`,
 *           |  where the Cockpit says so and what to do.
 *  Note     |  Mounted in the running app and in the start-up app, so a
 *           |  browser can be paired when Core has stopped on a
 *           |  database problem too. The response is never cached and
 *           |  sends no Referer on, whatever it redirects to.
 * ------------------------------------------------------------------
 */

import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { type LocalAuth, safeNext } from './localAuth';

export function pairingRoutes(auth: LocalAuth, opts: { secure?: boolean } = {}) {
  const r = new Hono<AppEnv>();

  r.post('/session/pair-codes', (c) => {
    c.header('cache-control', 'no-store');
    return c.json(auth.mintPairCode(), 201);
  });

  r.get('/session/pair', (c) => {
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    const code = c.req.query('code');
    if (!code || !auth.redeemPairCode(code)) return c.redirect('/?pair=failed', 303);
    // Behind a TLS-terminating proxy the request itself says http; the public URL or the forwarded scheme says https.
    const https =
      opts.secure === true ||
      new URL(c.req.url).protocol === 'https:' ||
      c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';
    c.header('set-cookie', auth.setCookie(https));
    return c.redirect(safeNext(c.req.query('next')), 303);
  });

  return r;
}
