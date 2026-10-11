/**
 * Connecting RunPod from the app: a key is checked against RunPod before
 * anything changes, sample nodes go once it is accepted, and disconnecting
 * brings them back, unless real nodes are still managed through RunPod.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { seedSampleNodes } from '../../src/nodes';
import { FakeProvider } from '../../src/providers/fake';
import { RunPodProvider } from '../../src/providers/runpod';
import { providerSwitch, SwitchableProvider } from '../../src/providers/switch';
import { MemoryStore } from '../../src/store';

const TOKEN = 't'.repeat(32);
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const GOOD = 'rpa_good_key_000';

/** A RunPod that accepts one key and lists no pods. */
const runpodWith = (apiKey: string) =>
  new RunPodProvider({
    apiKey,
    baseUrl: 'https://api.runpod.test',
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      const ok = (init?.headers as Record<string, string> | undefined)?.authorization === `Bearer ${GOOD}`;
      return new Response(
        JSON.stringify(ok ? { pods: [] } : { title: 'Unauthorized', status: 401, detail: 'Invalid API key' }),
        {
          status: ok ? 200 : 401,
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as typeof fetch,
  });

async function setup() {
  const store = new MemoryStore();
  const samples = async () => {
    const fake = new FakeProvider(20);
    await seedSampleNodes(store, fake);
    return fake;
  };
  const provider = new SwitchableProvider(await samples());
  const app = createApp({
    store,
    provider,
    token: TOKEN,
    costCapUsd: 100,
    queueDeadlineS: 60,
    pollMs: 5,
    connectProvider: providerSwitch({ store, provider, samples, connect: runpodWith }),
  });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`/control/v1${path}`, {
      method,
      headers: auth,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  return { store, call };
}

describe('connecting a provider from the app', () => {
  it('starts on sample nodes', async () => {
    const { call, store } = await setup();
    expect(await (await call('GET', '/provider')).json()).toMatchObject({ kind: 'fake', connected: false });
    expect((await store.listNodes()).every((n) => n.provider === 'fake')).toBe(true);
  });

  it('refuses a key RunPod does not accept, and changes nothing', async () => {
    const { call, store } = await setup();
    const before = (await store.listNodes()).length;
    const r = await call('PUT', '/provider', { kind: 'runpod', api_key: 'rpa_wrong_key_0' });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('provider.auth');
    expect((await store.listNodes()).length).toBe(before);
    expect(await (await call('GET', '/provider')).json()).toMatchObject({ kind: 'fake' });
  });

  it('connects with a good key, clears the samples, and comes back to them on disconnect', async () => {
    const { call, store } = await setup();
    const r = await call('PUT', '/provider', { kind: 'runpod', api_key: GOOD });
    expect(await r.json()).toMatchObject({ kind: 'runpod', connected: true });
    expect(await store.listNodes()).toEqual([]);
    expect(await (await call('GET', '/provider')).json()).toMatchObject({ kind: 'runpod', connected: true });

    const back = await call('DELETE', '/provider');
    expect(await back.json()).toMatchObject({ kind: 'fake', connected: false });
    expect((await store.listNodes()).length).toBeGreaterThan(0);
  });

  it('will not disconnect while real nodes are managed through RunPod', async () => {
    const { call, store } = await setup();
    const sample = (await store.listNodes())[0];
    await call('PUT', '/provider', { kind: 'runpod', api_key: GOOD });
    if (!sample) throw new Error('no sample node');
    await store.putNode({ ...sample, id: 'nod_real', provider: 'runpod', provider_ref: 'pod1' });
    const r = await call('DELETE', '/provider');
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('provider.nodes_exist');
    expect(await (await call('GET', '/provider')).json()).toMatchObject({ kind: 'runpod' });
  });
});
