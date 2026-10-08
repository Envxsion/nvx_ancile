/**
 * The Pro seam's routes and identity (DESIGN.md §9): a Pro route answers
 * only while its feature is licensed, roles gate writes in a team, the
 * free build's single owner can do everything, and a second GPU node is
 * a fleet feature while sample nodes never count.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { computeRoutes } from '../../src/compute/routes';
import { errorHandler } from '../../src/obs/errors';
import { identityMiddleware, ownerIdentity, proRoutes, roleAllows } from '../../src/pro/routes';
import type { IdentityProvider, Principal, ProRoute } from '../../src/pro/types';

const owner = ownerIdentity({ userId: 'usr_1', workspaceId: 'wsp_1' });

function app(opts: { routes: ProRoute[]; licensed: boolean; identity?: IdentityProvider }) {
  const a = new Hono<AppEnv>();
  a.onError(errorHandler);
  const api = new Hono<AppEnv>();
  api.use(
    '*',
    identityMiddleware(() => opts.identity ?? owner),
  );
  api.route('/', proRoutes({ routes: opts.routes, hasFeature: () => opts.licensed }));
  a.route('/api/v1', api);
  return a;
}

const echo: ProRoute = {
  method: 'POST',
  path: '/fleet/echo/:id',
  feature: 'fleet',
  handler: async (req) => ({
    status: 201,
    body: { id: req.params.id, body: req.body, who: req.principal?.userId },
  }),
};

const post = (a: Hono<AppEnv>, path: string, body: unknown = {}) =>
  a.request(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const asRole = (role: Principal['role']): IdentityProvider => ({
  resolve: async () => ({ userId: 'usr_2', workspaceId: 'wsp_1', role, name: 'Sam', via: 'session' }),
});

describe('Pro routes', () => {
  it('answer for the owner while the feature is licensed', async () => {
    const res = await post(app({ routes: [echo], licensed: true }), '/pro/fleet/echo/n1', { a: 1 });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'n1', body: { a: 1 }, who: 'usr_1' });
  });

  it('say which Pro feature is needed when it is not', async () => {
    const res = await post(app({ routes: [echo], licensed: false }), '/pro/fleet/echo/n1');
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; title: string } };
    expect(body.error.code).toBe('pro.feature_required');
    expect(body.error.title).toContain('GPU fleet');
  });

  it('let a viewer read but not write, and an admin route need an admin', async () => {
    const read: ProRoute = {
      method: 'GET',
      path: '/team/members',
      feature: 'team',
      handler: async () => ({ body: [] }),
    };
    const invite: ProRoute = { ...echo, path: '/team/invite', feature: 'team', role: 'admin' };
    const viewer = app({ routes: [read, echo], licensed: true, identity: asRole('viewer') });
    expect((await viewer.request('/api/v1/pro/team/members')).status).toBe(200);
    expect((await post(viewer, '/pro/fleet/echo/n1')).status).toBe(403);
    const member = app({ routes: [invite], licensed: true, identity: asRole('member') });
    const res = await post(member, '/pro/team/invite');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('auth.role_too_low');
  });

  it('ask to sign in when a team has nobody signed in, except on open paths', async () => {
    const signIn: ProRoute = { ...echo, path: '/team/sign-in', public: true };
    const nobody: IdentityProvider = {
      resolve: async () => null,
      open: (p) => p.startsWith('/pro/team/sign-in'),
    };
    const a = app({ routes: [echo, signIn], licensed: true, identity: nobody });
    expect((await post(a, '/pro/fleet/echo/n1')).status).toBe(401);
    expect((await post(a, '/pro/team/sign-in')).status).toBe(201);
  });

  it('tell a team’s audit log about every change, after answering, and not about reads', async () => {
    const seen: string[] = [];
    const team: IdentityProvider = {
      ...asRole('member'),
      record: async (p, r) => {
        seen.push(`${p.name} ${r.method} ${r.path} ${r.status}`);
      },
    };
    const read: ProRoute = {
      method: 'GET',
      path: '/team/members',
      feature: 'team',
      handler: async () => ({ body: [] }),
    };
    const a = app({ routes: [echo, read], licensed: true, identity: team });
    await post(a, '/pro/fleet/echo/n1');
    await a.request('/api/v1/pro/team/members');
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['Sam POST /pro/fleet/echo/n1 201']);
  });

  it('rank roles', () => {
    expect(roleAllows('owner', 'admin')).toBe(true);
    expect(roleAllows('member', 'admin')).toBe(false);
    expect(roleAllows('viewer', 'viewer')).toBe(true);
  });
});

describe('GPU nodes on the free edition', () => {
  const client = (providers: string[]) => {
    const sent: unknown[] = [];
    return {
      sent,
      c: {
        configured: true,
        get: async <T>() => ({ items: providers.map((p) => ({ provider: p })) }) as T,
        send: async <T>(_m: string, _p: string, b?: unknown) => {
          sent.push(b);
          return { id: 'nod_x' } as T;
        },
        raw: async () => new Response(),
      },
    };
  };
  const add = (hasFleet: boolean, providers: string[]) => {
    const { c, sent } = client(providers);
    const a = new Hono<AppEnv>();
    a.onError(errorHandler);
    a.route('/', computeRoutes({ client: c, hasFeature: () => hasFleet }));
    const res = a.request('/compute/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider_ref: 'pod123' }),
    });
    return { sent, res };
  };

  it('allow the first real node, and any number beside the sample nodes', async () => {
    expect((await add(false, []).res).status).toBe(201);
    expect((await add(false, ['fake', 'fake']).res).status).toBe(201);
  });

  it('make a second real node a fleet feature', async () => {
    const { res, sent } = add(false, ['runpod']);
    expect((await res).status).toBe(402);
    expect(sent).toHaveLength(0);
    expect((await add(true, ['runpod', 'local']).res).status).toBe(201);
  });
});
