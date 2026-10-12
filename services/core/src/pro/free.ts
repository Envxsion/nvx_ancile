/**
 * ------------------------------------------------------------------
 *  Title    |  Pro seam: the free build
 *  Ref      |  DESIGN.md §9 · NVX licensing and updates v2 §7
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  What runs when pro/ is empty. Pro arrives only as an
 *           |  update, so the free build takes a key: it claims a seat
 *           |  for this computer and keeps the token, which the
 *           |  desktop host sends when it asks nvx.sh for updates.
 *           |  nvx.sh then offers the Pro build of the same version
 *           |  or newer.
 *  How      |  activate: POST {base}/activate {key, device:{id,label},
 *           |  transfer?}, the same request the Pro licence manager
 *           |  makes. The token goes in settings (license.token), the
 *           |  key in the secret store (license.claim_key). Nothing is
 *           |  verified or unlocked here: this build has no Pro in it
 *           |  and cannot check a Pro token. deactivate: POST
 *           |  {base}/deactivate (best effort), then forget both.
 *  Note     |  Standalone GPL code: it imports nothing from pro/. The
 *           |  token is never logged and never leaves Core except to
 *           |  nvx.sh and the desktop host.
 * ------------------------------------------------------------------
 */

import { randomUUID } from 'node:crypto';
import { AncileError, type license, pro } from '@nvx/contracts';
import { FREE, SKEW_S } from '../license/verify';
import type { SecretStore } from '../secrets';
import type { SettingsStore } from '../settings';
import type { ProLicense } from './types';

export const DEVICE_KEY = 'license.device_id';
const TOKEN_KEY = 'license.token';
/** Kept through a revocation (nvx.sh measures Pro's end from it); cleared only by deactivate. */
const LAST_TOKEN_KEY = 'license.last_token';
const CHECKED_KEY = 'license.checked_at';
const SUSPENDED_KEY = 'license.suspended';
const KEY_SECRET = 'license.claim_key';
const CLAIM_KEY = /^NVX-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export function featureList(status: license.LicenseStatus): license.LicenseDetails['features'] {
  return pro.PRO_FEATURES.map((id) => ({
    id,
    ...pro.PRO_FEATURE_WORDS[id],
    unlocked: status.tier !== 'free' && status.features.includes(id),
  }));
}

/** What the free build needs to claim a seat. */
export interface FreeHost {
  settings: SettingsStore;
  secrets?: SecretStore;
  licenseUrl?: string;
  deviceLabel?: string;
  fetch?: typeof fetch;
  /** The licence clock (license/clock.ts): skew-tolerant, trusts nvx.sh's time. */
  now?: () => number;
  /** nvx.sh's Date header from each reply, for the licence clock. */
  observeDate?: (date: string | null) => void;
}

/** The licence server's refusal, in its v2 ({error:{code,...}}) or v1 ({error:"code"}) shape. */
interface ServerError {
  error?: string | { code?: string; title?: string; hint?: string; context?: Record<string, unknown> };
  reason?: string;
  title?: string;
  hint?: string;
  devices?: { label: string; last_seen?: string }[];
  max_devices?: number;
}

type Reply =
  | { kind: 'ok'; token: string }
  | { kind: 'error'; status: number; body: ServerError }
  | { kind: 'offline' };

function fail(code: string, title: string, hint: string, status = 422, context?: Record<string, unknown>) {
  return new AncileError({
    code,
    title,
    hint,
    status,
    errorClass: status === 429 || status === 503 ? 'transient' : 'permanent',
    ...(context && { context }),
  });
}

/** A refusal from /activate, as the same errors the Pro build gives (the Cockpit handles both alike). */
export function refusal(status: number, b: ServerError): AncileError {
  const nested = typeof b.error === 'object' && b.error ? b.error : null;
  const why = (nested ? nested.code : typeof b.error === 'string' ? b.error : (b.reason ?? ''))?.replace(
    /^license\./,
    '',
  );
  const ctx = { ...(nested?.context ?? {}) } as { devices?: unknown; max_devices?: unknown };
  if (status === 409 && why === 'seat_taken')
    return fail(
      'license.seat_taken',
      'This key is already on as many computers as it allows',
      'Choose "Move it here" to use it on this computer instead. The one used least recently goes back to the free edition.',
      409,
      { devices: b.devices ?? ctx.devices ?? [], max_devices: b.max_devices ?? ctx.max_devices ?? 3 },
    );
  if (status === 409 && why === 'transfer_limit')
    return fail(
      'license.transfer_limit',
      'This key has moved too many times recently',
      'Wait a few days, or ask nvx.sh support to move it for you.',
      409,
    );
  if (status === 404 || why === 'not_found')
    return fail(
      'license.not_found',
      'There is no licence with that key',
      'Copy the key again from your nvx.sh account.',
      404,
    );
  if (status === 410 && why === 'paused')
    return fail(
      'license.paused',
      'This licence is paused',
      'Resume it in your nvx.sh account, then try again.',
      410,
    );
  if (status === 410 && why === 'expired')
    return fail(
      'license.expired',
      'This licence has ended',
      'Renew it in your nvx.sh account, then try again.',
      410,
    );
  if (status === 410 && why === 'released')
    return fail(
      'license.released',
      'This computer was released from the licence',
      'Turn Pro on again with your key to take a seat here.',
      410,
    );
  if (status === 410)
    return fail(
      'license.revoked',
      'This licence was revoked',
      'Contact nvx.sh support if you think this is a mistake.',
      410,
    );
  if (status === 429)
    return fail('license.rate_limited', 'Too many tries just now', 'Wait a minute, then try again.', 429);
  return fail(
    'license.rejected',
    nested?.title ?? b.title ?? 'That key was not accepted',
    nested?.hint ?? b.hint ?? 'Check the key (NVX-XXXX-XXXX-XXXX) in your nvx.sh account.',
  );
}

/** A token's expiry, read without checking it (for what the screen says, never to unlock anything). */
function expiryOf(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function freeModule(host: FreeHost): { build: 'free'; license: ProLicense } {
  const { settings, secrets } = host;
  const doFetch = host.fetch ?? fetch;
  let deviceId = '';

  const call = async (path: string, payload: unknown): Promise<Reply> => {
    if (!host.licenseUrl) return { kind: 'offline' };
    let res: Response;
    try {
      res = await doFetch(`${host.licenseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nvx-product': 'ancile' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return { kind: 'offline' };
    }
    // A captive portal or a proxy's error page is not an answer from nvx.sh.
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return { kind: 'offline' };
    host.observeDate?.(res.headers.get('date'));
    const b = (await res.json().catch(() => null)) as (ServerError & { token?: string }) | null;
    if (!b || typeof b !== 'object') return { kind: 'offline' };
    if (res.ok && typeof b.token === 'string') return { kind: 'ok', token: b.token };
    if (res.status >= 500) return { kind: 'offline' };
    return { kind: 'error', status: res.status, body: b };
  };

  const details = async (): Promise<license.LicenseDetails> => {
    const token = (await settings.get<string>(TOKEN_KEY)) ?? null;
    const key = secrets ? await secrets.get(KEY_SECRET) : null;
    const suspended = await settings.get<string>(SUSPENDED_KEY);
    // This build cannot verify a Pro token, but it can tell the screen that the
    // one held has run out (Pro ended, so no Pro update is coming).
    const exp = token ? expiryOf(token) : null;
    const now = (host.now ?? Date.now)();
    const lapse: license.LicenseLapse | null =
      suspended === 'paused'
        ? 'paused'
        : suspended || (exp !== null && exp + SKEW_S * 1000 < now)
          ? 'expired'
          : null;
    return {
      status: { ...FREE, lapse },
      build: 'free',
      device_id: deviceId,
      key_held: !!(token || key),
      checked_at: (await settings.get<string>(CHECKED_KEY)) ?? null,
      problem: null,
      features: featureList(FREE),
    };
  };

  return {
    build: 'free',
    license: {
      async start() {
        deviceId = (await settings.get<string>(DEVICE_KEY)) ?? '';
        if (!deviceId) {
          deviceId = randomUUID();
          await settings.set(DEVICE_KEY, deviceId);
        }
      },
      stop() {},
      status: () => FREE,
      details,
      async activate(input: string, opts: { transfer?: boolean } = {}) {
        const key = input.trim().toUpperCase();
        if (!CLAIM_KEY.test(key))
          throw fail(
            'license.invalid',
            'Enter your licence key here',
            'Copy the key (NVX-XXXX-XXXX-XXXX) from your nvx.sh account. Pro then arrives as an update.',
          );
        const r = await call('/activate', {
          key,
          device: { id: deviceId, label: host.deviceLabel ?? 'This computer' },
          ...(opts.transfer && { transfer: true }),
        });
        if (r.kind === 'offline')
          throw fail(
            'license.unreachable',
            'nvx.sh could not be reached',
            'Check your internet connection and try again.',
            503,
          );
        if (r.kind === 'error') throw refusal(r.status, r.body);
        await settings.set(TOKEN_KEY, r.token);
        await settings.set(LAST_TOKEN_KEY, r.token);
        await settings.set(SUSPENDED_KEY, null);
        await settings.set(CHECKED_KEY, new Date().toISOString());
        if (secrets) await secrets.set(KEY_SECRET, key);
        return details();
      },
      refresh: details,
      async deactivate() {
        const token = await settings.get<string>(TOKEN_KEY);
        if (token) await call('/deactivate', { token, device: { id: deviceId } }).catch(() => undefined);
        await settings.set(TOKEN_KEY, null);
        await settings.set(LAST_TOKEN_KEY, null);
        await settings.set(SUSPENDED_KEY, null);
        if (secrets) await secrets.delete(KEY_SECRET);
        return details();
      },
    },
  };
}
