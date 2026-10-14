/**
 * Admin → Licence's routes: details are told as the person asking may use
 * them (the principal goes to the licence), and turning Pro on, checking it
 * or moving it changes the licence for everyone, so it needs an admin. The
 * free build's single owner is one.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { licenseRoutes } from '../../src/license/routes';
import { FREE } from '../../src/license/verify';
import { errorHandler } from '../../src/obs/errors';
import { identityMiddleware, ownerIdentity } from '../../src/pro/routes';
import type { IdentityProvider, Principal, ProLicense } from '../../src/pro/types';

function fakeLicence() {
  const calls: string[] = [];
  const asked: (Principal | null | undefined)[] = [];
  const d = async (who?: Principal | null) => {
    asked.push(who);
    return {
      status: FREE,
      build: 'pro' as const,
      device_id: 'dev',
      key_held: false,
      checked_at: null,
      problem: null,
      seat: who === undefined || (who !== null && who.pro !== false),
      features: [],
    };
  };
  const licence: ProLicense = {
    start: async () => undefined,
    stop: () => undefined,
    status: () => FREE,
    details: d,
    activate: async () => {
      calls.push('activate');
      return d();
    },
    refresh: async () => {
      calls.push('refresh');
      return d();
    },
    deactivate: async () => {
      calls.push('deactivate');
      return d();
    },
  };
  return { licence, calls, asked };
}

const as = (role: Principal['role'], pro?: boolean): IdentityProvider => ({
  resolve: async () => ({
    userId: 'usr_2',
    workspaceId: 'w',
    role,
    name: 'Sam',
    via: 'session',
    ...(pro !== undefined && { pro }),
  }),
});
const nobody: IdentityProvider = { resolve: async () => null, open: (p) => p === '/license/details' };

function app(identity: IdentityProvider) {
  const f = fakeLicence();
  const a = new Hono<AppEnv>();
  a.onError(errorHandler);
  const api = new Hono<AppEnv>();
  api.use(
    '*',
    identityMiddleware(() => identity),
  );
  api.route('/', licenseRoutes({ license: f.licence }));
  a.route('/api/v1', api);
  const post = (path: string, body: unknown = {}) =>
    a.request(`/api/v1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { a, post, ...f };
}

describe('licence routes', () => {
  it('refuse a member or a viewer turning Pro on, checking it or moving it, and never reach the licence', async () => {
    // A viewer is stopped before the route (no writes at all); a member at it.
    for (const [role, need] of [
      ['member', 'admin'],
      ['viewer', 'member'],
    ] as const) {
      const { post, calls } = app(as(role));
      for (const path of ['/license/activate', '/license/deactivate', '/license/refresh']) {
        const res = await post(path, { key: 'NVX-ABCD-EFGH-JK23' });
        expect(res.status).toBe(403);
        expect(
          ((await res.json()) as { error: { code: string; context: { need: string } } }).error,
        ).toMatchObject({
          code: 'auth.role_too_low',
          context: { need },
        });
      }
      expect(calls).toEqual([]);
    }
  });

  it('let an admin, an owner and the free build’s owner do them, answering for that person', async () => {
    for (const identity of [
      as('admin', false),
      as('owner'),
      ownerIdentity({ userId: 'usr_1', workspaceId: 'w' }),
    ]) {
      const { post, calls, asked } = app(identity);
      expect((await post('/license/activate', { key: 'NVX-ABCD-EFGH-JK23' })).status).toBe(200);
      expect((await post('/license/refresh')).status).toBe(200);
      const res = await post('/license/deactivate');
      expect(res.status).toBe(200);
      expect(calls).toEqual(['activate', 'refresh', 'deactivate']);
      expect(asked.at(-1)).toMatchObject({ role: expect.any(String) });
    }
    // An admin without a Pro seat may still manage the licence; what it says is for them.
    const { post } = app(as('admin', false));
    expect(((await (await post('/license/refresh')).json()) as { seat: boolean }).seat).toBe(false);
  });

  it('tell each person what they may use, and nobody signed in only what the gate needs', async () => {
    const free = app(as('member', false));
    const res = await free.a.request('/api/v1/license/details');
    expect(((await res.json()) as { seat: boolean }).seat).toBe(false);
    expect(free.asked.at(-1)).toMatchObject({ pro: false });

    const out = app(nobody);
    const r = await out.a.request('/api/v1/license/details');
    expect(r.status).toBe(200);
    expect(out.asked.at(-1)).toBeNull();
    expect((await out.post('/license/activate', { key: 'NVX-ABCD-EFGH-JK23' })).status).toBe(401);
  });
});
