import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hasFeature, parseKeyMap, verifyToken } from '../src/license/verify';
import { redact, redactText } from '../src/obs/redact';
import { MemorySecretStore, SecretBox } from '../src/secrets';

describe('SecretBox', () => {
  const box = new SecretBox(randomBytes(32).toString('base64'));

  it('round-trips and uses a fresh nonce each time', async () => {
    const a = box.seal('anthropic', 'sk-ant-xyz');
    const b = box.seal('anthropic', 'sk-ant-xyz');
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(box.open('anthropic', a)).toBe('sk-ant-xyz');
    const store = new MemorySecretStore(box);
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
  });

  it('refuses a ciphertext moved to another name, or a different key', () => {
    const sealed = box.seal('openai', 'secret');
    expect(() => box.open('anthropic', sealed)).toThrow(/could not be decrypted/);
    expect(() => new SecretBox(randomBytes(32).toString('base64')).open('openai', sealed)).toThrow();
  });

  it('rejects short keys', () => {
    expect(() => new SecretBox(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('licence tokens (NVX family format)', () => {
  // A throwaway key pair made for this test; no real key is ever committed.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x as string;
  const keys = { t1: raw };
  const now = Date.parse('2026-10-07T00:00:00Z');
  const s = (d: number) => Math.floor((now + d) / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const mint = (
    claims: Record<string, unknown>,
    header: Record<string, unknown> = { alg: 'EdDSA', kid: 't1' },
  ) => {
    const signed = `${b64(header)}.${b64(claims)}`;
    return `${signed}.${sign(null, Buffer.from(signed, 'ascii'), privateKey).toString('base64url')}`;
  };
  const base = {
    v: 1,
    id: 'lic_1',
    tier: 'pro',
    feat: ['beam', 'team', 'warp_drive'],
    iat: s(-1000),
    exp: s(30 * 86_400_000),
    kid: 't1',
    dev: 'dev1',
  };
  const opts = { keys, build: 'pro' as const, deviceId: 'dev1', now };

  it('verifies a good token and drops unknown features', () => {
    const { status, failure } = verifyToken(mint(base), opts);
    expect(failure).toBeUndefined();
    expect(status).toMatchObject({ tier: 'pro', verified: true, features: ['beam', 'team'], lapse: null });
    expect(hasFeature(status, 'beam')).toBe(true);
    expect(hasFeature(status, 'sync')).toBe(false);
  });

  it('"*" unlocks every feature this build knows, and max_access is the tester tier', () => {
    const { status } = verifyToken(mint({ ...base, tier: 'max_access', feat: '*' }), opts);
    expect(status.tier).toBe('max_access');
    expect(status.features).toContain('insights');
  });

  it('a free build ignores every token', () => {
    expect(verifyToken(mint(base), { ...opts, build: 'free' })).toMatchObject({
      status: { tier: 'free' },
      failure: 'build_free',
    });
  });

  it('names each failure', () => {
    const t = mint(base);
    const [h, , sig] = t.split('.');
    expect(verifyToken(`${h}.${b64({ ...base, feat: '*' })}.${sig}`, opts).failure).toBe('bad_token');
    expect(verifyToken(mint(base, { alg: 'EdDSA', kid: 'k9' }), opts).failure).toBe('unknown_kid');
    expect(verifyToken(mint(base, { alg: 'RS256', kid: 't1' }), opts).failure).toBe('bad_token');
    expect(verifyToken(mint({ ...base, kid: 'other' }), opts).failure).toBe('bad_token');
    expect(verifyToken(mint(base), { ...opts, deviceId: 'dev2' }).failure).toBe('wrong_device');
    expect(verifyToken('nonsense', opts).failure).toBe('bad_token');
    expect(verifyToken(`${t}.extra`, opts).failure).toBe('bad_token');
  });

  it('allows 120 s of clock skew, then expires', () => {
    expect(verifyToken(mint({ ...base, exp: s(-60_000) }), opts).status.tier).toBe('pro');
    expect(verifyToken(mint({ ...base, exp: s(-200_000) }), opts)).toMatchObject({
      failure: 'expired',
      status: { tier: 'free', lapse: 'expired' },
    });
    expect(verifyToken(mint({ ...base, iat: s(600_000) }), opts).failure).toBe('bad_token');
  });

  it('flags a token close to expiry', () => {
    expect(verifyToken(mint({ ...base, exp: s(86_400_000) }), opts).status.lapse).toBe('renewal_due');
  });

  it('reads the build-time key map in either form', () => {
    expect(parseKeyMap('{"k1":"abc","k2":"def"}')).toEqual({ k1: 'abc', k2: 'def' });
    expect(parseKeyMap('k1:abc, k2:def')).toEqual({ k1: 'abc', k2: 'def' });
    expect(parseKeyMap(undefined)).toEqual({});
  });
});

describe('redaction', () => {
  it('masks secrets by key and by shape', () => {
    expect(
      redact({
        apiKey: 'sk-ant-abcdefghijklmnop1234',
        nested: { authorization: 'Bearer abcdefghijklmnopqrstu' },
      }),
    ).toEqual({
      apiKey: '…1234',
      nested: { authorization: '…rstu' },
    });
    expect(redactText('url postgres://ancile:hunter2@db:5432/x and key sk-proj-abcdefghijklmnopqrstuv')).toBe(
      'url postgres://ancile:…@db:5432/x and key sk-…',
    );
  });
});
