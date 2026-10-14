/**
 * Connecting RunPod from Admin → Compute: Core keeps the key, encrypted, only
 * once the Controller has accepted it, and gives it back to a Controller that
 * restarted without it.
 */
import { AncileError } from '@nvx/contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import type { ControllerClient } from '../../src/compute/controller';
import { computeRoutes, providerSync, RUNPOD_KEY_SECRET } from '../../src/compute/routes';
import { errorHandler } from '../../src/obs/errors';
import { MemorySecretStore, SecretBox } from '../../src/secrets';

const KEY = 'rpa_good_key_000';

/** A Controller that starts with no provider ('none', every real install) or sample nodes ('fake'). */
function controller(start: 'fake' | 'none' = 'fake') {
  let kind: string = start;
  const calls: string[] = [];
  /** RunPod not answering (the network not up yet at launch): the Controller says 503. */
  const net = { offline: false };
  const client: ControllerClient = {
    configured: true,
    async get<T>(path: string) {
      calls.push(`GET ${path}`);
      return { kind, connected: kind !== 'fake' && kind !== 'none', detail: '' } as T;
    },
    async send<T>(method: string, path: string, body?: unknown) {
      calls.push(`${method} ${path}`);
      if (method === 'PUT') {
        if (net.offline)
          throw new AncileError({
            code: 'provider.unreachable',
            title: 'RunPod could not be reached',
            hint: 'No response from RunPod.',
            status: 503,
            retryable: true,
          });
        if ((body as { api_key: string }).api_key !== KEY)
          throw new AncileError({
            code: 'provider.auth',
            title: 'RunPod did not accept that key',
            hint: 'Invalid API key',
            status: 422,
          });
        kind = 'runpod';
      }
      if (method === 'DELETE') kind = start;
      return { kind, connected: kind !== 'fake' && kind !== 'none', detail: '' } as T;
    },
    async raw() {
      return new Response();
    },
  };
  return { client, calls, net, restart: () => (kind = start) };
}

const secretsStore = () => new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64')));

function app(client: ControllerClient, secrets = secretsStore()) {
  const a = new Hono<AppEnv>();
  a.onError(errorHandler);
  a.route('/api/v1', computeRoutes({ client, secrets }));
  const call = (method: string, path: string, body?: unknown) =>
    a.request(`/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  return { call, secrets };
}

describe('connecting RunPod from the app', () => {
  it('saves the key only once the Controller accepts it', async () => {
    const c = controller();
    const { call, secrets } = app(c.client);
    const bad = await call('PUT', '/compute/provider', { api_key: 'rpa_wrong_000' });
    expect(bad.status).toBe(422);
    expect(await secrets.get(RUNPOD_KEY_SECRET)).toBeUndefined();

    const good = await call('PUT', '/compute/provider', { api_key: KEY });
    expect(await good.json()).toMatchObject({ kind: 'runpod', connected: true, key_saved: true });
    expect(await secrets.get(RUNPOD_KEY_SECRET)).toBe(KEY);

    const off = await call('DELETE', '/compute/provider');
    expect(await off.json()).toMatchObject({ kind: 'fake', key_saved: false });
    expect(await secrets.get(RUNPOD_KEY_SECRET)).toBeUndefined();
  });

  it('gives the key back to a Controller that restarted without it, and only then', async () => {
    const c = controller();
    const secrets = secretsStore();
    const sync = providerSync(c.client, secrets);
    await sync();
    expect(c.calls).toEqual([]); // nothing saved: nothing to do

    await secrets.set(RUNPOD_KEY_SECRET, KEY);
    await sync();
    expect(c.calls).toEqual(['GET /provider', 'PUT /provider']);

    c.calls.length = 0;
    await sync();
    expect(c.calls).toEqual(['GET /provider']); // already connected

    c.restart();
    c.calls.length = 0;
    await Promise.all([sync(), sync()]); // one at a time
    expect(c.calls).toEqual(['GET /provider', 'PUT /provider']);
  });

  it('gives the key back to a real Controller that started keyless (provider none)', async () => {
    // Every launch of the desktop app: the Controller holds the key in memory only.
    const c = controller('none');
    const secrets = secretsStore();
    await secrets.set(RUNPOD_KEY_SECRET, KEY);
    const sync = providerSync(c.client, secrets);
    await sync();
    expect(c.calls).toEqual(['GET /provider', 'PUT /provider']);
    c.calls.length = 0;
    await sync();
    expect(c.calls).toEqual(['GET /provider']);
    c.restart();
    c.calls.length = 0;
    await sync();
    expect(c.calls).toEqual(['GET /provider', 'PUT /provider']);
  });

  it('does not keep offering RunPod a key it refused, until the key changes', async () => {
    const c = controller('none');
    const secrets = secretsStore();
    await secrets.set(RUNPOD_KEY_SECRET, 'rpa_revoked_000');
    const sync = providerSync(c.client, secrets);
    await sync();
    expect(c.calls).toEqual(['GET /provider', 'PUT /provider']);
    c.calls.length = 0;
    await sync();
    await sync();
    expect(c.calls).toEqual([]);
    // A new key is tried at once.
    await secrets.set(RUNPOD_KEY_SECRET, KEY);
    await sync();
    expect(c.calls).toEqual(['GET /provider', 'PUT /provider']);
  });

  it('reading the provider in Compute gives a keyless Controller the key first', async () => {
    const c = controller('none');
    const secrets = secretsStore();
    await secrets.set(RUNPOD_KEY_SECRET, KEY);
    const { call } = app(c.client, secrets);
    const r = await call('GET', '/compute/provider');
    expect(await r.json()).toMatchObject({ kind: 'runpod', connected: true, key_saved: true });
  });

  it('a key saved before the first launch connects even when RunPod did not answer at first', async () => {
    // The key is already in the store when Core first starts; at that moment
    // RunPod cannot be reached. That is no refusal: the next try uses it.
    const c = controller('none');
    const secrets = secretsStore();
    await secrets.set(RUNPOD_KEY_SECRET, KEY);
    const sync = providerSync(c.client, secrets);
    c.net.offline = true;
    await sync();
    expect(sync.problem()).toMatchObject({ refused: false, title: 'RunPod could not be reached' });
    c.net.offline = false;
    c.calls.length = 0;
    await sync();
    expect(c.calls).toEqual(['GET /provider', 'PUT /provider']);
    expect(sync.problem()).toBeNull();
  });

  it('Compute hears why a saved key is not connected, and never that it is missing', async () => {
    const c = controller('none');
    const secrets = secretsStore();
    await secrets.set(RUNPOD_KEY_SECRET, 'rpa_revoked_000');
    const { call } = app(c.client, secrets);
    const r = await call('GET', '/compute/provider');
    expect(await r.json()).toMatchObject({
      kind: 'none',
      connected: false,
      key_saved: true,
      key_problem: { refused: true, title: 'RunPod did not accept that key' },
    });
  });
});
