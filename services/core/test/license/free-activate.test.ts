/**
 * The free build takes a key (NVX licensing and updates v2 §7): it claims a
 * seat with nvx.sh and keeps only the token, which the desktop host sends
 * when it asks for updates, so Pro arrives as an update. Nothing is
 * verified or unlocked here.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { freeModule } from '../../src/pro/free';
import { MemorySecretStore, SecretBox } from '../../src/secrets';
import { MemorySettings } from '../../src/settings';

const KEY = 'NVX-ABCD-EFGH-JK23';

type Call = { url: string; body: Record<string, unknown> };

function server(answer: (path: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, body });
    return answer(new URL(url).pathname, body);
  }) as typeof fetch;
  return { f, calls };
}

const json = (status: number, b: unknown) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

async function setup(fetchImpl: typeof fetch) {
  const settings = new MemorySettings();
  const secrets = new MemorySecretStore(new SecretBox(randomBytes(32).toString('base64')));
  const m = freeModule({
    settings,
    secrets,
    licenseUrl: 'https://licence.test/api/licenses/',
    deviceLabel: 'ana@laptop',
    fetch: fetchImpl,
  });
  await m.license.start();
  return { m, settings, secrets };
}

describe('free build licence', () => {
  it('activates with the key, keeps only the token and the key, and unlocks nothing', async () => {
    const s = server(() => json(200, { token: 'h.p.s' }));
    const { m, settings, secrets } = await setup(s.f);
    const d = await m.license.activate(' nvx-abcd-efgh-jk23 ');
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.url).toBe('https://licence.test/api/licenses/activate');
    expect(s.calls[0]?.body).toEqual({
      key: KEY,
      device: { id: d.device_id, label: 'ana@laptop' },
    });
    expect(await settings.get('license.token')).toBe('h.p.s');
    expect(await settings.get('license.last_token')).toBe('h.p.s');
    expect(await secrets.get('license.claim_key')).toBe(KEY);
    expect(d).toMatchObject({ build: 'free', key_held: true, status: { tier: 'free', lapse: null } });
    expect(d.features.every((f) => !f.unlocked)).toBe(true);
    expect(m.license.status().tier).toBe('free');
  });

  it('turns a taken seat into the error the Cockpit offers "Move it here" for, and moves it on request', async () => {
    const s = server((_p, b) =>
      b.transfer
        ? json(200, { token: 'h.p.moved' })
        : json(409, {
            error: { code: 'license.seat_taken', context: { devices: [{ label: 'desk' }], max_devices: 2 } },
          }),
    );
    const { m, settings } = await setup(s.f);
    await expect(m.license.activate(KEY)).rejects.toMatchObject({
      code: 'license.seat_taken',
      status: 409,
      context: { devices: [{ label: 'desk' }], max_devices: 2 },
    });
    expect(await settings.get('license.token')).toBeUndefined();
    await m.license.activate(KEY, { transfer: true });
    expect(s.calls[1]?.body.transfer).toBe(true);
    expect(await settings.get('license.token')).toBe('h.p.moved');
  });

  it('reads the older refusal shape too, and says when there is no such key', async () => {
    const seat = server(() =>
      json(409, { error: 'seat_taken', devices: [{ label: 'old' }], max_devices: 3 }),
    );
    await expect((await setup(seat.f)).m.license.activate(KEY)).rejects.toMatchObject({
      code: 'license.seat_taken',
      context: { devices: [{ label: 'old' }], max_devices: 3 },
    });
    const missing = server(() => json(404, { error: { code: 'license.not_found' } }));
    await expect((await setup(missing.f)).m.license.activate(KEY)).rejects.toMatchObject({
      code: 'license.not_found',
    });
  });

  it('refuses anything that is not a key without asking nvx.sh', async () => {
    const s = server(() => json(200, { token: 'x' }));
    const { m } = await setup(s.f);
    await expect(m.license.activate('abc.def.ghi')).rejects.toMatchObject({ code: 'license.invalid' });
    expect(s.calls).toHaveLength(0);
  });

  it('says nvx.sh could not be reached when offline, on a 5xx, or on a page that is not JSON', async () => {
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const down = server(() => json(503, { error: 'unavailable' }));
    const portal = server(
      () => new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } }),
    );
    for (const f of [offline, down.f, portal.f]) {
      const { m, settings } = await setup(f);
      await expect(m.license.activate(KEY)).rejects.toMatchObject({
        code: 'license.unreachable',
        status: 503,
      });
      expect(await settings.get('license.token')).toBeUndefined();
    }
  });

  it('deactivates: tells nvx.sh, then forgets the token and the key', async () => {
    const s = server((p) =>
      p.endsWith('/deactivate') ? json(200, { ok: true }) : json(200, { token: 'h.p.s' }),
    );
    const { m, settings, secrets } = await setup(s.f);
    await m.license.activate(KEY);
    const d = await m.license.deactivate();
    expect(s.calls[1]?.url).toBe('https://licence.test/api/licenses/deactivate');
    expect(s.calls[1]?.body).toEqual({ token: 'h.p.s', device: { id: d.device_id } });
    expect(await settings.get('license.token')).toBeUndefined();
    expect(await settings.get('license.last_token')).toBeUndefined();
    expect(await secrets.get('license.claim_key')).toBeUndefined();
    expect(d.key_held).toBe(false);
  });

  it('reports a held token that has run out as an ended licence (no Pro update is coming)', async () => {
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 3600 })).toString(
      'base64url',
    );
    const { m, settings } = await setup(server(() => json(500, {})).f);
    await settings.set('license.token', `h.${payload}.s`);
    expect((await m.license.details()).status.lapse).toBe('expired');
    await settings.set('license.token', 'h.p.s');
    await settings.set('license.suspended', 'paused');
    expect((await m.license.details()).status.lapse).toBe('paused');
  });
});
