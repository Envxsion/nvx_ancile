import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { clientErrorRoutes } from '../../src/diagnostics/client-errors';

const app = () => {
  const a = new Hono<AppEnv>();
  a.onError((_e, c) => c.json({}, 400));
  a.route(
    '/',
    clientErrorRoutes(() => 1000),
  );
  return a;
};
const post = (a: Hono<AppEnv>, b: unknown) =>
  a.request('/system/client-errors', { method: 'POST', body: JSON.stringify(b) });
const ok = { scope: 'panel', kind: 'TypeError', version: '0.1.1' };

describe('client errors', () => {
  it('takes a small report and keeps no message text', async () => {
    expect((await post(app(), ok)).status).toBe(204);
    expect((await post(app(), { ...ok, message: 'secret' })).status).toBe(400);
  });
  it('limits how many arrive a minute', async () => {
    const a = app();
    for (let i = 0; i < 20; i++) await post(a, ok);
    expect((await post(a, ok)).status).toBe(429);
  });
});
