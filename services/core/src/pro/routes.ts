/**
 * ------------------------------------------------------------------
 *  Title    |  Pro seam: routes and identity
 *  Ref      |  DESIGN.md §9
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Serve the routes Pro declares under /api/v1/pro, and ask
 *           |  "who is this?" for every /api/v1 request.
 *  How      |  Each Pro route names the feature it belongs to; the
 *           |  licence is read when the route is called, so a lapsed
 *           |  licence locks it at once and a renewed one opens it
 *           |  without a restart. Roles come from the principal: the
 *           |  free build's owner can do everything; in a team, writes
 *           |  need a member and reads a viewer unless a route says more.
 *  Note     |  The free identity always answers with the one owner, so
 *           |  nothing about a single-person install changes.
 * ------------------------------------------------------------------
 */

import { AncileError, pro as proContract } from '@nvx/contracts';
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireBrowserSession } from '../http/guard';
import type { IdentityProvider, Principal, ProRoute } from './types';

const RANK: Record<Principal['role'], number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function roleAllows(have: Principal['role'], need: Principal['role']): boolean {
  return RANK[have] >= RANK[need];
}

/** The free build's identity: the single person this install belongs to. */
export function ownerIdentity(owner: {
  userId: string;
  workspaceId: string;
  name?: string;
}): IdentityProvider {
  const principal: Principal = {
    userId: owner.userId,
    workspaceId: owner.workspaceId,
    role: 'owner',
    name: owner.name ?? 'You',
    via: 'owner',
    pro: true,
  };
  return { resolve: async () => principal };
}

export const featureRequired = (feature: proContract.ProFeature) =>
  new AncileError({
    code: 'pro.feature_required',
    title: `${proContract.PRO_FEATURE_WORDS[feature].title} is part of NVX Ancile Pro`,
    hint: 'Turn on Pro in Admin → Licence. Everything else keeps working on the free edition.',
    status: 402,
    errorClass: 'permanent',
    context: { feature },
  });

/** Pro is on here, but this person has no Pro seat (a team member the owner has not given one). */
export const seatRequired = (feature: proContract.ProFeature) =>
  new AncileError({
    code: 'pro.seat_required',
    title: `${proContract.PRO_FEATURE_WORDS[feature].title} needs a Pro seat`,
    hint: "Pro is on in this workspace, but your account has no Pro seat. Ask the workspace's owner for one in Admin → Team.",
    status: 403,
    errorClass: 'permanent',
    context: { feature },
  });

/**
 * Why a Pro feature is refused to this person now, or null when it is not:
 * not in the licence (402 pro.feature_required), or Pro is on but they have
 * no Pro seat (403 pro.seat_required).
 */
export function proRefusal(
  licensed: boolean,
  feature: proContract.ProFeature,
  who: Principal | null | undefined,
): AncileError | null {
  if (!licensed) return featureRequired(feature);
  if (who?.pro === false) return seatRequired(feature);
  return null;
}

export const signInRequired = () =>
  new AncileError({
    code: 'auth.sign_in_required',
    title: 'Sign in to this workspace first',
    hint: 'This workspace has a team. Sign in with your account or your identity provider.',
    status: 401,
    errorClass: 'permanent',
  });

export const roleTooLow = (need: Principal['role']) =>
  new AncileError({
    code: 'auth.role_too_low',
    title: 'Your role in this workspace cannot do that',
    hint: `It needs ${need === 'admin' ? 'an admin' : `a ${need}`}. Ask the workspace's owner or an admin.`,
    status: 403,
    errorClass: 'permanent',
    context: { need },
  });

const headersOf = (c: Context) => {
  const out: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
};

/**
 * Resolve the principal for each /api/v1 request. A provider that says
 * nobody (Teams, signed out) gets 401 except on the paths it opens.
 * Reads need a viewer and writes a member; finer checks are per route.
 * Under /pro each route declares its own lowest role (proRoutes checks
 * it), so one may let a viewer write: their own passphrase.
 */
export function identityMiddleware(current: () => IdentityProvider): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const identity = current();
    const path = c.req.path.replace(/^\/api\/v1/, '');
    const principal = await identity.resolve(headersOf(c));
    if (!principal) {
      if (identity.open?.(path)) return next();
      throw signInRequired();
    }
    c.set('principal', principal);
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    const ownRole = path === '/pro' || path.startsWith('/pro/');
    if (write && !ownRole && !roleAllows(principal.role, 'member') && !identity.open?.(path))
      throw roleTooLow('member');
    await next();
    // A team's audit log hears about every change; it never holds the answer up.
    if (write && identity.record)
      void identity
        .record(principal, { method: c.req.method, path, status: c.res.status })
        .catch(() => undefined);
  };
}

/** Mount Pro's routes. Each checks its feature, its role and the caller's Pro seat, when called. */
export function proRoutes(deps: {
  routes: ProRoute[];
  /** The licence, for the install as a whole (seats are read from the principal). */
  hasFeature: (feature: proContract.ProFeature) => boolean;
  /** Paths answered with 402 when no Pro route serves them (default: PRO_SEAM_ROUTES). */
  seams?: readonly { method: 'GET' | 'POST'; path: string; feature: proContract.ProFeature }[];
}): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  for (const route of deps.routes) {
    const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    r[method](`/pro${route.path}`, async (c) => {
      // Changing sync (approving or removing a device, its settings, its relay) is the paired browser's
      // alone, whatever the route is called: a script with the install key can read, not move your data.
      // Declared by feature because Pro's paths are Pro's own (http/localAuth.ts says which others).
      if (route.method !== 'GET' && route.feature === 'sync') requireBrowserSession(c);
      if (!deps.hasFeature(route.feature)) throw featureRequired(route.feature);
      const principal = (c.get('principal') as Principal | undefined) ?? null;
      if (!route.public) {
        if (!principal) throw signInRequired();
        const need = route.role ?? (route.method === 'GET' ? 'viewer' : 'member');
        if (!roleAllows(principal.role, need)) throw roleTooLow(need);
        if (route.seat !== false && principal.pro === false) throw seatRequired(route.feature);
      }
      const raw = route.method === 'GET' || route.method === 'DELETE' ? undefined : await c.req.text();
      let body: unknown;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          throw new AncileError({
            code: 'request.bad_json',
            title: 'That request body is not JSON',
            hint: 'Send a JSON body.',
            status: 400,
            errorClass: 'permanent',
          });
        }
      }
      const res = await route.handler({
        params: c.req.param() as Record<string, string>,
        query: c.req.query(),
        body,
        principal,
        headers: headersOf(c),
      });
      for (const [k, v] of Object.entries(res.headers ?? {})) c.header(k, v);
      const status = (res.status ?? 200) as 200;
      return res.body === undefined ? c.body(null, status === 200 ? 204 : status) : c.json(res.body, status);
    });
  }
  // The seam: a Pro route the build does not have still answers, with 402
  // naming its feature, so the Cockpit can show the locked state.
  const served = new Set(deps.routes.map((x) => `${x.method} ${x.path}`));
  for (const seam of deps.seams ?? proContract.PRO_SEAM_ROUTES) {
    if (served.has(`${seam.method} ${seam.path}`)) continue;
    const method = seam.method.toLowerCase() as 'get' | 'post';
    r[method](`/pro${seam.path}`, () => {
      throw featureRequired(seam.feature);
    });
  }
  return r;
}

/**
 * Where a Pro feature lives under /api/v1/pro, so the free build (and a Pro
 * build without that feature's routes) answers 402 there rather than 404:
 * the Cockpit then shows the feature as part of Pro.
 */
export const PRO_PATHS: Partial<Record<proContract.ProFeature, string>> = {
  context_packs: '/context-packs',
};

/** 402 pro.feature_required for every path of a Pro feature no Pro route answered. Mount after proRoutes. */
export function lockedProRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  for (const [feature, path] of Object.entries(PRO_PATHS) as [proContract.ProFeature, string][]) {
    const locked = () => {
      throw featureRequired(feature);
    };
    r.all(`/pro${path}`, locked);
    r.all(`/pro${path}/*`, locked);
  }
  return r;
}
