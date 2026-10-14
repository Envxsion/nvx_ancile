/**
 * Pro seats at the seam (DESIGN.md §9): a principal may carry `pro: false`
 * (a team member without a Pro seat). Pro's routes then refuse with
 * pro.seat_required, after the licence and the role, except routes marked
 * `seat: false`; the hasFeature lent to Pro narrows to the person when asked;
 * the free build's owner always has Pro; a second GPU node is a seat's too;
 * and under /pro each route's own role decides, so a viewer may write where a
 * route allows it, while the rest of /api/v1 keeps viewers to reading.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { computeRoutes } from '../../src/compute/routes';
import type { EventBus } from '../../src/events/bus';
import { errorHandler } from '../../src/obs/errors';
import { identityMiddleware, ownerIdentity, proRefusal, proRoutes } from '../../src/pro/routes';
import { proServices } from '../../src/pro/services';
import type { IdentityProvider, Principal, ProRoute } from '../../src/pro/types';

const person = (role: Principal['role'], pro?: boolean): IdentityProvider => ({
  resolve: async () => ({
    userId: 'usr_2',
    workspaceId: 'wsp_1',
    role,
    name: 'Sam',
    via: 'session',
    ...(pro !== undefined && { pro }),
  }),
});

function app(opts: {
  routes: ProRoute[];
  licensed?: boolean;
  identity: IdentityProvider;
  extra?: Hono<AppEnv>;
}) {
  const a = new Hono<AppEnv>();
  a.onError(errorHandler);
  const api = new Hono<AppEnv>();
  api.use(
    '*',
    identityMiddleware(() => opts.identity),
  );
  api.route('/', proRoutes({ routes: opts.routes, hasFeature: () => opts.licensed ?? true }));
  if (opts.extra) api.route('/', opts.extra);
  a.route('/api/v1', api);
  return a;
}

const beam: ProRoute = {
  method: 'GET',
  path: '/beam/x',
  feature: 'beam',
  handler: async () => ({ body: { ok: true } }),
};
const teamList: ProRoute = {
  method: 'GET',
  path: '/team/x',
  feature: 'team',
  seat: false,
  handler: async () => ({ body: { ok: true } }),
};
const signIn: ProRoute = {
  method: 'POST',
  path: '/team/auth/x',
  feature: 'team',
  public: true,
  handler: async () => ({ body: { ok: true } }),
};
const ownWrite: ProRoute = {
  method: 'POST',
  path: '/team/me/x',
  feature: 'team',
  role: 'viewer',
  seat: false,
  handler: async () => ({ body: { ok: true } }),
};
const memberWrite: ProRoute = {
  method: 'POST',
  path: '/team/y',
  feature: 'team',
  seat: false,
  handler: async () => ({ body: { ok: true } }),
};

const post = (a: Hono<AppEnv>, path: string) =>
  a.request(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
const codeOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; context?: unknown } }).error;

describe('Pro seats at the seam', () => {
  it('refuse a Pro route to someone without a seat, naming the feature', async () => {
    const a = app({ routes: [beam], identity: person('admin', false) });
    const res = await a.request('/api/v1/pro/beam/x');
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toMatchObject({ code: 'pro.seat_required', context: { feature: 'beam' } });
  });

  it('open it with a seat, or with no word on seats at all', async () => {
    expect(
      (await app({ routes: [beam], identity: person('member', true) }).request('/api/v1/pro/beam/x')).status,
    ).toBe(200);
    expect(
      (await app({ routes: [beam], identity: person('member') }).request('/api/v1/pro/beam/x')).status,
    ).toBe(200);
  });

  it('check the licence first: without it, the answer is still that the feature is Pro', async () => {
    const res = await app({ routes: [beam], licensed: false, identity: person('member', false) }).request(
      '/api/v1/pro/beam/x',
    );
    expect(res.status).toBe(402);
    expect((await codeOf(res)).code).toBe('pro.feature_required');
  });

  it('check the role before the seat', async () => {
    const admin: ProRoute = { ...beam, role: 'admin' };
    const res = await app({ routes: [admin], identity: person('member', false) }).request(
      '/api/v1/pro/beam/x',
    );
    expect((await codeOf(res)).code).toBe('auth.role_too_low');
  });

  it('let anyone through on routes marked seat: false, and on public ones', async () => {
    const a = app({ routes: [teamList, signIn], identity: person('viewer', false) });
    expect((await a.request('/api/v1/pro/team/x')).status).toBe(200);
    expect((await post(a, '/pro/team/auth/x')).status).toBe(200);
  });

  it('leave the role under /pro to each route: a viewer writes where a route allows it, nowhere else', async () => {
    const elsewhere = new Hono<AppEnv>();
    elsewhere.post('/threads', (c) => c.json({ ok: true }, 201));
    const a = app({ routes: [ownWrite, memberWrite], identity: person('viewer', false), extra: elsewhere });
    expect((await post(a, '/pro/team/me/x')).status).toBe(200);
    const member = await post(a, '/pro/team/y');
    expect(member.status).toBe(403);
    expect(await codeOf(member)).toMatchObject({ code: 'auth.role_too_low', context: { need: 'member' } });
    const core = await post(a, '/threads');
    expect(core.status).toBe(403);
    expect((await codeOf(core)).code).toBe('auth.role_too_low');
    // A /pro path nothing serves is not a way around it.
    expect((await post(a, '/pro/nothing')).status).toBe(404);
  });

  it('give the free build’s single owner Pro', async () => {
    expect(await ownerIdentity({ userId: 'usr_1', workspaceId: 'wsp_1' }).resolve({})).toMatchObject({
      role: 'owner',
      pro: true,
    });
  });

  it('narrow the hasFeature lent to Pro to the person, when one is named', () => {
    const svc = proServices({
      sql: {} as never,
      controller: { configured: false } as never,
      events: { publish: async () => undefined } as unknown as EventBus,
      hasFeature: (f) => f === 'beam',
      owner: { userId: 'usr_1', workspaceId: 'wsp_1' },
    });
    const sam = (pro?: boolean): Principal => ({
      userId: 'u',
      workspaceId: 'w',
      role: 'member',
      name: 'Sam',
      via: 'session',
      ...(pro !== undefined && { pro }),
    });
    expect(svc.hasFeature('beam')).toBe(true);
    expect(svc.hasFeature('beam', null)).toBe(true);
    expect(svc.hasFeature('beam', sam(true))).toBe(true);
    expect(svc.hasFeature('beam', sam())).toBe(true);
    expect(svc.hasFeature('beam', sam(false))).toBe(false);
    expect(svc.hasFeature('sync', sam(true))).toBe(false);
  });

  it('say why, or nothing, through proRefusal', () => {
    const free: Principal = {
      userId: 'u',
      workspaceId: 'w',
      role: 'member',
      name: 'Sam',
      via: 'session',
      pro: false,
    };
    expect(proRefusal(false, 'fleet', free)?.code).toBe('pro.feature_required');
    expect(proRefusal(true, 'fleet', free)?.code).toBe('pro.seat_required');
    expect(proRefusal(true, 'fleet', { ...free, pro: true })).toBeNull();
    expect(proRefusal(true, 'fleet', undefined)).toBeNull();
  });
});

describe('a second GPU node, in a team', () => {
  const compute = (licensed: boolean) => {
    const sent: unknown[] = [];
    const client = {
      configured: true,
      get: async <T>() => ({ items: [{ provider: 'runpod' }] }) as T,
      send: async <T>(_m: string, _p: string, b?: unknown) => {
        sent.push(b);
        return { id: 'nod_x' } as T;
      },
      raw: async () => new Response(),
    };
    return { sent, routes: computeRoutes({ client: client as never, hasFeature: () => licensed }) };
  };
  const add = (a: Hono<AppEnv>) =>
    a.request('/api/v1/compute/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider_ref: 'pod123' }),
    });

  it('needs a Pro seat as well as the licence', async () => {
    const c = compute(true);
    const res = await add(app({ routes: [], identity: person('member', false), extra: c.routes }));
    expect(res.status).toBe(403);
    expect((await codeOf(res)).code).toBe('pro.seat_required');
    expect(c.sent).toHaveLength(0);
    expect((await add(app({ routes: [], identity: person('member', true), extra: c.routes }))).status).toBe(
      201,
    );
  });

  it('without the licence, says it is Pro, seat or not', async () => {
    const c = compute(false);
    const res = await add(app({ routes: [], identity: person('member', true), extra: c.routes }));
    expect(res.status).toBe(402);
    expect((await codeOf(res)).code).toBe('pro.feature_required');
  });
});
