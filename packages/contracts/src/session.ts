/**
 * ------------------------------------------------------------------
 *  Title    |  Local session: who may call /api/v1
 *  Ref      |  DESIGN.md §4.1, §5.8 · docs/api.md (Calling the API)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  Core listens on localhost, so any process on the machine
 *           |  can reach it. Every /api/v1 route therefore needs proof
 *           |  that the caller is the owner: the install key, or a
 *           |  browser session paired with it.
 *  How      |  The key is made the first time Core starts and kept in
 *           |  Core's data folder as local-api.key (mode 0600). A
 *           |  script sends it as `Authorization: Bearer <key>`. A
 *           |  browser is paired once: `pnpm pair` (or the desktop
 *           |  app) asks Core for a one-time code, and
 *           |  GET /api/v1/session/pair?code=… sets an HttpOnly,
 *           |  SameSite=Strict cookie and answers 303. The key itself
 *           |  never goes into an address.
 *  Note     |  Approvals, grants, permissions, scopes, the privacy
 *           |  policy and the other routes that decide what an agent
 *           |  may do need the browser session: a script that has the
 *           |  key can read and work, but cannot answer for the owner.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

/** The file in Core's data folder that holds the install key. */
export const LOCAL_KEY_FILE = 'local-api.key';

/** No credentials, or ones Core does not accept (401). The Cockpit shows "Connect this browser". */
export const LOCAL_KEY_REQUIRED = 'auth.local_key_required';

/** A route that only the paired browser may use was reached with a bare key (403). */
export const BROWSER_SESSION_REQUIRED = 'auth.browser_session_required';

/** Where a pairing code is redeemed (no credentials needed; the code is the credential). */
export const PAIR_PATH = '/api/v1/session/pair';

/** How long a pairing code lives, in seconds. */
export const PAIR_CODE_TTL_S = 60;

/** The name of the session cookie for a Core on this port (profiles share `localhost`, so it carries the port). */
export const sessionCookieName = (port: number) => `ancile_session_${port}`;

/** POST /api/v1/session/pair-codes (bearer key only): a code good for one pairing. */
export const PairCode = z.object({
  /** Single use; redeem at PAIR_PATH?code=… */
  code: z.string().min(32),
  expires_in_s: z.number().int().positive(),
});
export type PairCode = z.infer<typeof PairCode>;
