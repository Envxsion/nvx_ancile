import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { FakeProvider } from '../src/providers/fake';
import { MemoryStore } from '../src/store';

/**
 * /ready is probed without credentials by Core's supervisor, the desktop
 * shell and container health checks, so it must be public and must say no
 * more than ready or not (details stay behind the token on /selftest).
 */
const make = () =>
  createApp({
    store: new MemoryStore(),
    provider: new FakeProvider(0),
    token: 'secret-token-123',
    costCapUsd: 100,
    queueDeadlineS: 60,
    pollMs: 5,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });

describe('/ready', () => {
  it('answers without a token and reveals nothing beyond readiness', async () => {
    const res = await make().request('/ready');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true });
  });

  it('keeps /selftest behind the token', async () => {
    expect((await make().request('/selftest')).status).toBe(401);
  });
});
