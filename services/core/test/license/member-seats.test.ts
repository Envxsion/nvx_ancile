/**
 * The member_seats claim (pro/docs/license-server-brief.md, "Member seats"):
 * carried through verification as it is, ignored when it is not a whole
 * number from 1, and a bad value never costs the licence. The free build's
 * details always say its one person has a seat.
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyToken } from '../../src/license/verify';
import { freeModule } from '../../src/pro/free';
import { MemorySecretStore, SecretBox } from '../../src/secrets';
import { MemorySettings } from '../../src/settings';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keys = { k1: publicKey.export({ format: 'jwk' }).x as string };
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(extra: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const h = enc({ alg: 'EdDSA', kid: 'k1' });
  const p = enc({
    v: 2,
    product: 'ancile',
    id: 'lic_1',
    tier: 'pro',
    feat: '*',
    iat: now - 5,
    exp: now + 86_400,
    kid: 'k1',
    dev: 'dev-1',
    ...extra,
  });
  return `${h}.${p}.${sign(null, Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
}
const check = (extra: Record<string, unknown>) =>
  verifyToken(token(extra), { keys, build: 'pro', deviceId: 'dev-1' });

describe('the member_seats claim', () => {
  it('is carried through as the licence server sent it', () => {
    const r = check({ member_seats: 5 });
    expect(r.failure).toBeUndefined();
    expect(r.status.verified).toBe(true);
    expect(r.claims?.member_seats).toBe(5);
  });

  it('is absent when the server does not send it', () => {
    const r = check({});
    expect(r.status.verified).toBe(true);
    expect(r.claims?.member_seats).toBeUndefined();
  });

  it('is dropped, never the licence, when it is not a whole number from 1', () => {
    for (const bad of [0, -1, 1.5, '3', null, true, 1e9]) {
      const r = check({ member_seats: bad });
      expect(r.failure).toBeUndefined();
      expect(r.status.verified).toBe(true);
      expect(r.claims?.member_seats).toBeUndefined();
    }
  });
});

describe('the free build', () => {
  it('says its one person has a seat', async () => {
    const m = freeModule({
      settings: new MemorySettings(),
      secrets: new MemorySecretStore(new SecretBox(randomBytes(32).toString('base64'))),
    });
    await m.license.start();
    expect((await m.license.details()).seat).toBe(true);
  });
});
