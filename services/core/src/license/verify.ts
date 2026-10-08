/**
 * ------------------------------------------------------------------
 *  Title    |  Licence verification
 *  Ref      |  DESIGN.md §9, packages/contracts/src/license.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The NVX family token, checked offline: is it signed by
 *           |  a key this build trusts, for this computer, and still
 *           |  in date? Public by design, like the rest of the family:
 *           |  knowing how a token is checked does not help forge one.
 *  How      |  header.payload.signature, base64url, unpadded. The
 *           |  header must be {alg:"EdDSA", kid} with kid equal to the
 *           |  payload's and present in the key map; Ed25519 over the
 *           |  ASCII bytes of "header.payload". 120 s of clock skew.
 *           |  Unknown features are dropped (closed enum).
 *  Note     |  A free build ignores every token (build_free). Keys
 *           |  come from NVX_LICENSE_KEYS at build time; none are
 *           |  committed.
 * ------------------------------------------------------------------
 */

import { createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto';
import { license } from '@nvx/contracts';

type Status = license.LicenseStatus;
type Failure = license.TokenFailure;

export const SKEW_S = 120;
/** A token this close to expiry, not yet renewed, is flagged so the screen can say so. */
export const RENEWAL_DUE_S = 3 * 24 * 3600;

export const FREE: Status = {
  tier: 'free',
  features: [],
  verified: false,
  offline_grace: false,
  expires_at: null,
  lapse: null,
};

/** kid → raw Ed25519 public key, base64url (32 bytes). */
export type KeyMap = Record<string, string>;

const keyCache = new Map<string, KeyObject>();
function publicKey(raw: string): KeyObject {
  let k = keyCache.get(raw);
  if (!k) {
    k = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
    keyCache.set(raw, k);
  }
  return k;
}

/**
 * NVX_LICENSE_KEYS as given at build time: JSON (`{"k1":"<base64url>"}`)
 * or `k1:<base64url>,k2:<base64url>`. Anything unreadable is no keys.
 */
export function parseKeyMap(raw: string | undefined): KeyMap {
  if (!raw?.trim()) return {};
  const out: KeyMap = {};
  try {
    const j = JSON.parse(raw) as unknown;
    if (j && typeof j === 'object')
      for (const [kid, v] of Object.entries(j)) if (typeof v === 'string') out[kid] = v.trim();
    return out;
  } catch {
    for (const pair of raw.split(',')) {
      const [kid, v] = pair.split(':').map((s) => s.trim());
      if (kid && v) out[kid] = v;
    }
    return out;
  }
}

const json = (b64: string): unknown => {
  try {
    return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

export interface Verified {
  status: Status;
  failure?: Failure;
  claims?: license.TokenClaims;
}

export function verifyToken(
  token: string,
  opts: { keys: KeyMap; build: 'free' | 'pro'; deviceId: string; now?: number },
): Verified {
  if (opts.build === 'free') return { status: FREE, failure: 'build_free' };
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts.some((p) => !p || !/^[A-Za-z0-9_-]+$/.test(p)))
    return { status: FREE, failure: 'bad_token' };
  const [h, p, sig] = parts as [string, string, string];

  const header = license.TokenHeader.safeParse(json(h));
  if (!header.success) return { status: FREE, failure: 'bad_token' };
  const raw = opts.keys[header.data.kid];
  if (!raw) return { status: FREE, failure: 'unknown_kid' };

  let ok = false;
  try {
    ok = edVerify(null, Buffer.from(`${h}.${p}`, 'ascii'), publicKey(raw), Buffer.from(sig, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) return { status: FREE, failure: 'bad_token' };

  const parsed = license.TokenClaims.safeParse(json(p));
  if (!parsed.success || parsed.data.kid !== header.data.kid) return { status: FREE, failure: 'bad_token' };
  const claims = parsed.data;
  if (claims.dev !== opts.deviceId) return { status: FREE, failure: 'wrong_device', claims };

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (claims.iat > now + SKEW_S) return { status: FREE, failure: 'bad_token', claims };
  const expiresAt = new Date(claims.exp * 1000).toISOString();
  if (claims.exp + SKEW_S < now)
    return { status: { ...FREE, expires_at: expiresAt, lapse: 'expired' }, failure: 'expired', claims };

  const known = new Set<string>(license.PRO_FEATURES);
  const features =
    claims.feat === '*'
      ? [...license.PRO_FEATURES]
      : claims.feat.filter((f): f is license.ProFeature => known.has(f));
  return {
    claims,
    status: {
      tier: claims.tier,
      features,
      verified: true,
      offline_grace: false,
      expires_at: expiresAt,
      lapse: claims.exp - now < RENEWAL_DUE_S ? 'renewal_due' : null,
    },
  };
}

export function hasFeature(status: Status, feature: license.ProFeature): boolean {
  return status.tier !== 'free' && status.features.includes(feature);
}
