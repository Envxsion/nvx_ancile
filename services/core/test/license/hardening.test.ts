/**
 * Licence hardening: a release build trusts only the keys built in and
 * ignores NVX_TIER, and expiry is checked against a time that only moves
 * forward, so winding the clock back keeps nothing alive.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chosenTier, RELEASE_BUILD, trustedKeys } from '../../src/build';
import { LicenceClock } from '../../src/license/clock';
import { verifyToken } from '../../src/license/verify';
import { MemorySettings } from '../../src/settings';

const official: Record<string, string> = { k1: 'official' };
const mine: Record<string, string> = { k9: 'mine' };

describe('release builds', () => {
  it('run from source as a development build', () => {
    expect(RELEASE_BUILD).toBe(false);
  });

  it('trust only the keys built in, whatever the environment says', () => {
    expect(trustedKeys(official, mine, true)).toBe(official);
    expect(trustedKeys(official, null, true)).toBe(official);
    // Development and tests may use their own signing key.
    expect(trustedKeys(official, mine, false)).toBe(mine);
    expect(trustedKeys(official, null, false)).toBe(official);
  });

  it('ignore NVX_TIER, so the edition is whatever was bundled', () => {
    expect(chosenTier('pro', true)).toBeUndefined();
    expect(chosenTier('free', true)).toBeUndefined();
    expect(chosenTier('free', false)).toBe('free');
  });
});

function token(claims: Record<string, unknown>) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x as string;
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = enc({ alg: 'EdDSA', kid: 'k1' });
  const p = enc({ v: 1, id: 'lic_1', tier: 'pro', feat: '*', kid: 'k1', dev: 'dev-1', ...claims });
  const sig = sign(null, Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
  return { token: `${h}.${p}.${sig}`, keys: { k1: x } };
}

describe('licence clock', () => {
  const DAY = 86_400_000;

  it('never goes backwards, and remembers across restarts', async () => {
    const settings = new MemorySettings();
    let t = Date.parse('2026-10-09T00:00:00Z');
    const clock = new LicenceClock(settings, () => t);
    await clock.load();
    t += 10 * DAY;
    expect(clock.now()).toBe(t);
    const later = t;
    t -= 30 * DAY; // wound back
    expect(clock.now()).toBe(later);
    expect(clock.behind()).toBe(true);
    const again = new LicenceClock(settings, () => t);
    await again.load();
    expect(again.now()).toBe(later);
  });

  it('keeps an expired token expired when the clock is wound back', async () => {
    const issued = Date.parse('2026-10-01T00:00:00Z') / 1000;
    const { token: tok, keys } = token({ iat: issued, exp: issued + 14 * 86_400 });
    let t = (issued + 20 * 86_400) * 1000; // six days past expiry
    const clock = new LicenceClock(new MemorySettings(), () => t);
    await clock.load();
    clock.now();
    t = (issued + 86_400) * 1000; // back to the day after issue
    const r = verifyToken(tok, { keys, build: 'pro', deviceId: 'dev-1', now: clock.now() });
    expect(r.failure).toBe('expired');
    // Without the floor the same token would pass: the floor is what stops it.
    expect(verifyToken(tok, { keys, build: 'pro', deviceId: 'dev-1', now: t }).failure).toBeUndefined();
  });

  it('learns the true time from the licence server and from a token', async () => {
    let t = Date.parse('2026-01-01T00:00:00Z');
    const clock = new LicenceClock(new MemorySettings(), () => t);
    await clock.load();
    clock.observeHeader('Fri, 09 Oct 2026 00:00:00 GMT');
    expect(new Date(clock.now()).toISOString()).toBe('2026-10-09T00:00:00.000Z');
    clock.observe(Date.parse('2026-10-10T00:00:00Z'));
    expect(new Date(clock.now()).toISOString()).toBe('2026-10-10T00:00:00.000Z');
    clock.observeHeader('not a date');
    t = Date.parse('2026-12-01T00:00:00Z');
    expect(new Date(clock.now()).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('token v2 (NVX licensing v2)', () => {
  const now = Math.floor(Date.now() / 1000);
  const times = { iat: now - 10, exp: now + 86_400 };

  it('accepts v1, and v2 for NVX Ancile', () => {
    const v1 = token(times);
    expect(verifyToken(v1.token, { keys: v1.keys, build: 'pro', deviceId: 'dev-1' }).status.verified).toBe(
      true,
    );
    const v2 = token({ ...times, v: 2, product: 'ancile' });
    expect(verifyToken(v2.token, { keys: v2.keys, build: 'pro', deviceId: 'dev-1' }).status.verified).toBe(
      true,
    );
  });

  it('refuses a token for another NVX product', () => {
    const other = token({ ...times, v: 2, product: 'session' });
    const r = verifyToken(other.token, { keys: other.keys, build: 'pro', deviceId: 'dev-1' });
    expect(r.failure).toBe('wrong_product');
    expect(r.status.tier).toBe('free');
  });

  it('refuses a version it does not know', () => {
    const v3 = token({ ...times, v: 3, product: 'ancile' });
    expect(verifyToken(v3.token, { keys: v3.keys, build: 'pro', deviceId: 'dev-1' }).failure).toBe(
      'bad_token',
    );
  });
});
