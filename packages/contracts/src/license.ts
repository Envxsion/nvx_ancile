/**
 * Editions (DESIGN.md §9): the NVX family licence. Claim keys look like
 * NVX-XXXX-XXXX-XXXX; a key is exchanged once for a token, and the token
 * is checked offline on every start. A token is
 *   base64url(header) "." base64url(payload) "." base64url(signature)
 * unpadded, the header {alg:"EdDSA", kid}, the signature Ed25519 over the
 * ASCII bytes of `header.payload`. Public keys are a kid map built into
 * the app. Features are a closed enum (pro.ts): a token can never unlock
 * something this build does not know about.
 */
import { z } from 'zod';
import { ProFeature } from './pro';

export { PRO_FEATURES, ProFeature } from './pro';

/** Crockford base32 without I L O U. */
export const ClaimKey = z
  .string()
  .regex(/^NVX-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

/** `max_access` is the family's tester grant: everything, and kept out of analytics. */
export const LicenseTier = z.enum(['free', 'pro', 'max_access']);
export type LicenseTier = z.infer<typeof LicenseTier>;

export const TokenHeader = z.object({ alg: z.literal('EdDSA'), kid: z.string().min(1).max(32) });
export type TokenHeader = z.infer<typeof TokenHeader>;

export const TokenClaims = z.object({
  /** 1, or 2 (NVX licensing v2: adds `product`). Both are accepted. */
  v: z.union([z.literal(1), z.literal(2)]),
  /** v2: the product this token is for. A token for another product is refused. */
  product: z.string().min(1).max(32).optional(),
  /** The licence row on the licence server. */
  id: z.string().min(1).max(64),
  tier: z.enum(['pro', 'max_access']),
  /** Features this licence unlocks, or "*" for all of them. Unknown names are dropped. */
  feat: z.union([z.literal('*'), z.array(z.string())]),
  iat: z.number().int(),
  exp: z.number().int(),
  kid: z.string(),
  /** The device the token is bound to. */
  dev: z.string().min(1).max(64),
  note: z.string().max(200).optional(),
});
export type TokenClaims = z.infer<typeof TokenClaims>;

/** Why a token did not unlock anything. `build_free`: a free build ignores every token. */
export const TokenFailure = z.enum([
  'bad_token',
  'expired',
  'wrong_device',
  'wrong_product',
  'unknown_kid',
  'build_free',
]);
export type TokenFailure = z.infer<typeof TokenFailure>;

/**
 * What needs your attention, if anything:
 * - `paused` or `expired`: the server suspended Pro; the key is kept
 * - `offline`: nvx.sh could not be reached; Pro works until the token expires
 * - `renewal_due`: the token expires within three days and has not been renewed
 */
export const LicenseLapse = z.enum(['paused', 'expired', 'offline', 'renewal_due']);
export type LicenseLapse = z.infer<typeof LicenseLapse>;

export const LicenseStatus = z.object({
  tier: LicenseTier,
  features: z.array(ProFeature),
  verified: z.boolean(),
  /** True when the licence server was unreachable and the held token is in use. */
  offline_grace: z.boolean(),
  expires_at: z.string().nullable(),
  lapse: LicenseLapse.nullable(),
});
export type LicenseStatus = z.infer<typeof LicenseStatus>;

/** Admin → Licence. */
export const LicenseDetails = z.object({
  status: LicenseStatus,
  /** Which build this is: a free build has no Pro code in it at all. */
  build: z.enum(['free', 'pro']),
  device_id: z.string(),
  /** A key is held (a suspended licence keeps its key). */
  key_held: z.boolean(),
  checked_at: z.string().nullable(),
  problem: z.string().nullable(),
  features: z.array(z.object({ id: ProFeature, title: z.string(), body: z.string(), unlocked: z.boolean() })),
});
export type LicenseDetails = z.infer<typeof LicenseDetails>;
