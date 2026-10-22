/**
 * Who calls /api/v1 in a test: the install key every test Core is built with, a script that
 * holds it, and a browser paired with it (http/localAuth.ts). A test that builds the app
 * must build it with a LocalAuth; there is no way to leave the guard out.
 */
import { LocalAuth } from '../../src/http/localAuth';

/** The install key every test Core is built with. */
export const LOCAL_KEY = 'K'.repeat(43);
/** Core's port in tests: it names the session cookie. */
export const LOCAL_PORT = 7700;
/** An origin the Cockpit is served from, so a browser-style request passes the guard. */
export const COCKPIT_ORIGIN = 'http://localhost:7701';

/** The credentials of a test caller; each field is what the request carries (absent: nothing). */
export interface Credentials {
  /** `Authorization: Bearer <this>`. */
  bearer?: string;
  /** The paired browser's session cookie. */
  cookie?: boolean;
  /** The Origin header. */
  origin?: string;
}

/** A paired browser on the Cockpit: the session cookie and its origin. */
export const BROWSER: Credentials = { cookie: true, origin: COCKPIT_ORIGIN };
/** A script with the install key and nothing else. */
export const SCRIPT: Credentials = { bearer: LOCAL_KEY };

export const testLocalAuth = (opts: { key?: string; port?: number; now?: () => number } = {}) =>
  new LocalAuth({
    key: opts.key ?? LOCAL_KEY,
    port: opts.port ?? LOCAL_PORT,
    ...(opts.now && { now: opts.now }),
  });

/** The headers a caller with these credentials sends to an app built with `auth`. */
export const headersFor = (auth: LocalAuth, who: Credentials): Record<string, string> => ({
  ...(who.bearer !== undefined && { authorization: `Bearer ${who.bearer}` }),
  ...(who.cookie && { cookie: auth.setCookie(false).split(';')[0] ?? '' }),
  ...(who.origin !== undefined && { origin: who.origin }),
});
