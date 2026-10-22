/**
 * Who may call the Cockpit API (docs/api.md, Calling the API). Core listens on
 * localhost, so a shell command an agent runs can reach it as easily as the
 * Cockpit can. Every route needs the install key or a paired browser; the
 * routes that decide what an agent may do need the paired browser itself.
 * Each test here fails if the check it names is taken out.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent } from '@nvx/contracts';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { requestGuard } from '../../src/http/guard';
import { accessFor, cleanPath, ensureLocalKey, LocalAuth, safeNext } from '../../src/http/localAuth';
import { errorHandler } from '../../src/obs/errors';
import { redactText, registerSecret } from '../../src/obs/redact';
import { proRoutes } from '../../src/pro/routes';
import type { ProRoute } from '../../src/pro/types';
import {
  BROWSER,
  COCKPIT_ORIGIN,
  type Credentials,
  type Harness,
  harness,
  LOCAL_KEY,
  SCRIPT,
} from '../support/harness';
import { headersFor, testLocalAuth } from '../support/local';

let h: Harness;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; title: string; hint: string } }).error;

const get = (path: string, who: Credentials, extra: Record<string, string> = {}) =>
  h.request(path, { headers: extra }, who);
const post = (path: string, who: Credentials, body: unknown = {}, extra: Record<string, string> = {}) =>
  h.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) },
    who,
  );

/** A run stopped on a question, and the id of the question. */
async function pendingApproval(): Promise<{ approvalId: string; runId: string }> {
  const t = await h.newThread();
  const sent = await h.send(t, '/tool fs_write {"path":"docs/a.md","content":"x"}');
  expect((await h.settle(sent.run_id)).status).toBe('waiting_approval');
  const ask = (await h.eventsOf(sent.run_id)).find(
    (e): e is Extract<RunEvent, { type: 'approval.required' }> => e.type === 'approval.required',
  );
  return { approvalId: ask?.approval_id ?? '', runId: sent.run_id };
}

describe('the install key file', () => {
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'ancile-key-'));
    dirs.push(d);
    return d;
  };

  it('is made once, is 32 random bytes, and is the same on the next start', async () => {
    const dir = tmp();
    const first = await ensureLocalKey(dir);
    expect(first.created).toBe(true);
    expect(first.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first.key, 'base64url')).toHaveLength(32);
    const again = await ensureLocalKey(dir);
    expect(again).toMatchObject({ key: first.key, created: false });
    // No half-written file is left beside it.
    expect(readdirSync(dir)).toEqual(['local-api.key']);
  });

  it.skipIf(process.platform === 'win32')('is readable by its owner only', async () => {
    const dir = tmp();
    const { path } = await ensureLocalKey(dir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('is made owner-only again if its mode was loosened', async () => {
    const dir = tmp();
    const { path } = await ensureLocalKey(dir);
    const { chmodSync } = await import('node:fs');
    chmodSync(path, 0o644);
    await ensureLocalKey(dir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('replaces a file that is not a key', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'local-api.key'), 'not a key');
    const made = await ensureLocalKey(dir);
    expect(made).toMatchObject({ created: true });
    expect(made.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await ensureLocalKey(dir)).toMatchObject({ key: made.key, created: false });
    expect(readdirSync(dir)).toEqual(['local-api.key']);
  });

  it('is one key when several starts race to make it', async () => {
    const dir = tmp();
    const all = await Promise.all(Array.from({ length: 5 }, () => ensureLocalKey(dir)));
    expect(new Set(all.map((b) => b.key)).size).toBe(1);
    expect(all.filter((b) => b.created)).toHaveLength(1);
    expect(existsSync(join(dir, 'local-api.key'))).toBe(true);
    expect(readdirSync(dir)).toEqual(['local-api.key']);
  });

  it('is refused by LocalAuth when it is the wrong shape', () => {
    expect(() => new LocalAuth({ key: 'short', port: 7700 })).toThrow();
  });
});

describe('a request with no credentials is refused', () => {
  it('on reads and on changes, with a title and a hint that say what to do', async () => {
    h = await harness();
    for (const [method, path] of [
      ['GET', '/threads'],
      ['GET', '/system/health'],
      ['GET', '/events'],
      ['GET', '/license'],
      ['GET', '/approvals'],
      ['POST', '/threads'],
      ['PUT', '/permissions/preset'],
    ] as const) {
      const res = await h.request(path, { method, headers: { 'content-type': 'application/json' } }, {});
      expect(res.status, `${method} ${path}`).toBe(401);
      const err = await errorOf(res);
      expect(err.code).toBe('auth.local_key_required');
      expect(err.hint).toContain('pnpm pair');
    }
  });

  it('even when the request names the Cockpit as its origin', async () => {
    h = await harness();
    const res = await get('/threads', { origin: COCKPIT_ORIGIN });
    expect(res.status).toBe(401);
  });

  it('and nothing a refused request carries is let into the answer', async () => {
    h = await harness();
    const res = await get('/threads', { bearer: 'Z'.repeat(43) });
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(LOCAL_KEY);
    expect(text).not.toContain('Z'.repeat(43));
  });
});

describe('a wrong key is refused', () => {
  it('whatever it looks like, and the key in an address is not read', async () => {
    h = await harness();
    const wrong = ['Z'.repeat(43), LOCAL_KEY.slice(0, -1), `${LOCAL_KEY}x`, LOCAL_KEY.toLowerCase(), ''];
    for (const bearer of wrong) {
      const res = await get('/threads', { bearer });
      expect(res.status, bearer).toBe(401);
      expect((await errorOf(res)).code).toBe('auth.local_key_required');
    }
    // Another scheme, and the right key in the wrong place.
    expect((await get('/threads', {}, { authorization: `Basic ${LOCAL_KEY}` })).status).toBe(401);
    expect((await get(`/threads?key=${LOCAL_KEY}`, {})).status).toBe(401);
    expect((await get('/threads', {}, { 'x-api-key': LOCAL_KEY })).status).toBe(401);
    // A browser cookie made for another install's key.
    const other = testLocalAuth({ key: 'O'.repeat(43) });
    const stale = other.setCookie(false).split(';')[0] ?? '';
    expect((await get('/threads', { origin: COCKPIT_ORIGIN }, { cookie: stale })).status).toBe(401);
    // The right key still works.
    expect((await get('/threads', SCRIPT)).status).toBe(200);
  });
});

describe('a request with no Origin is fine only with the key', () => {
  it('refuses a change that carries the session cookie but no Origin, and allows it with the key', async () => {
    h = await harness();
    const cookieOnly = await post('/threads', { cookie: true }, { title: 'x' });
    expect(cookieOnly.status).toBe(403);
    expect((await errorOf(cookieOnly)).code).toBe('request.cross_origin');
    expect((await post('/threads', SCRIPT, { title: 'x' })).status).toBe(201);
    // Reading with the cookie needs no Origin: a browser sends none on a same-site read.
    expect((await get('/threads', { cookie: true })).status).toBe(200);
  });
});

describe('a cookie request from a foreign Origin is refused', () => {
  const evil = 'https://evil.example';

  it('for changes and for reads, and for the opaque origin', async () => {
    h = await harness();
    for (const origin of [evil, 'null', 'http://localhost:9999', 'http://localhost:7701.evil.example']) {
      const change = await post('/threads', { cookie: true, origin }, { title: 'x' });
      expect(change.status, origin).toBe(403);
      expect((await errorOf(change)).code).toBe('request.cross_origin');
      expect((await get('/threads', { cookie: true, origin })).status, origin).toBe(403);
    }
    expect(h.repo.threads.size).toBe(0);
  });

  it('even with the key, and for a cross-site fetch that names no origin', async () => {
    h = await harness();
    expect((await post('/threads', { bearer: LOCAL_KEY, origin: evil }, { title: 'x' })).status).toBe(403);
    const crossSite = await post(
      '/threads',
      { cookie: true },
      { title: 'x' },
      { 'sec-fetch-site': 'cross-site' },
    );
    expect(crossSite.status).toBe(403);
    const crossSiteKey = await post('/threads', SCRIPT, { title: 'x' }, { 'sec-fetch-site': 'cross-site' });
    expect(crossSiteKey.status).toBe(403);
  });
});

describe('answers that decide what an agent may do need the browser session', () => {
  it('refuses an approval answered with only the install key, and the question stays open', async () => {
    h = await harness();
    const { approvalId } = await pendingApproval();
    const viaScript = await post(`/approvals/${approvalId}`, SCRIPT, {
      decision: 'approve',
      scope: 'always',
    });
    expect(viaScript.status).toBe(403);
    expect((await errorOf(viaScript)).code).toBe('auth.browser_session_required');
    // With the key and a Cockpit origin, but no cookie: still not the browser.
    const viaOrigin = await post(
      `/approvals/${approvalId}`,
      { ...SCRIPT, origin: COCKPIT_ORIGIN },
      {
        decision: 'approve',
        scope: 'always',
      },
    );
    expect(viaOrigin.status).toBe(403);
    // The batch route too.
    const batch = await post('/approvals/batch', SCRIPT, { approval_ids: [approvalId], decision: 'approve' });
    expect(batch.status).toBe(403);
    expect((await h.perms.getApproval(approvalId))?.status).toBe('pending');
    expect(await h.perms.listGrants()).toHaveLength(0);

    // The paired browser can.
    const viaBrowser = await post(`/approvals/${approvalId}`, BROWSER, {
      decision: 'approve',
      scope: 'once',
    });
    expect(viaBrowser.status).toBe(200);
    expect((await h.perms.getApproval(approvalId))?.status).toBe('approved');
  });

  it('refuses a grant made, changed or taken back with only the key, and the list of them', async () => {
    h = await harness();
    const { approvalId } = await pendingApproval();
    await post(`/approvals/${approvalId}`, BROWSER, {
      decision: 'approve',
      scope: 'always',
      pattern: 'fs:/workspace/docs/**',
    });
    const [grant] = await h.perms.listGrants();
    expect(grant).toBeTruthy();
    const id = grant?.id ?? '';
    expect((await get('/grants', SCRIPT)).status).toBe(403);
    expect((await get('/approvals', SCRIPT)).status).toBe(403);
    expect((await h.request(`/grants/${id}`, { method: 'DELETE' }, SCRIPT)).status).toBe(403);
    expect(
      (
        await h.request(
          `/grants/${id}`,
          { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"ttl_seconds":60}' },
          SCRIPT,
        )
      ).status,
    ).toBe(403);
    expect((await post(`/grants/${id}/restore`, SCRIPT)).status).toBe(403);
    expect(await h.perms.listGrants()).toHaveLength(1);
    // Revoking is the browser's.
    expect((await h.request(`/grants/${id}`, { method: 'DELETE' }, BROWSER)).status).toBe(204);
  });

  it('refuses the permission preset with only the key, but lets a script read it', async () => {
    h = await harness();
    const put = (who: Credentials) =>
      h.request(
        '/permissions/preset',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ preset: 'hands_off' }),
        },
        who,
      );
    const refused = await put(SCRIPT);
    expect(refused.status).toBe(403);
    expect((await errorOf(refused)).code).toBe('auth.browser_session_required');
    expect(((await (await get('/permissions/preset', SCRIPT)).json()) as { preset: string }).preset).toBe(
      'balanced',
    );
    expect((await put(BROWSER)).status).toBe(200);
  });

  it('wants the cookie and an Origin together for a change, not either alone', async () => {
    h = await harness();
    const { approvalId } = await pendingApproval();
    // Key plus cookie, but no Origin: a script that borrowed a cookie.
    const res = await post(
      `/approvals/${approvalId}`,
      { bearer: LOCAL_KEY, cookie: true },
      {
        decision: 'approve',
        scope: 'once',
      },
    );
    expect(res.status).toBe(403);
    expect((await h.perms.getApproval(approvalId))?.status).toBe('pending');
  });

  it('cannot be walked around with another way of writing the path', async () => {
    h = await harness();
    const { approvalId } = await pendingApproval();
    for (const path of [
      `//approvals/${approvalId}`,
      `/approvals//${approvalId}`,
      `/approvals/${approvalId}/`,
      `/./approvals/${approvalId}`,
    ]) {
      const res = await post(path, SCRIPT, { decision: 'approve', scope: 'once' });
      expect([403, 404], path).toContain(res.status);
    }
    expect((await h.perms.getApproval(approvalId))?.status).toBe('pending');
  });

  it('holds for the routes that move data or finish setup, written any other way', async () => {
    h = await harness({ ops: true });
    const sent = (method: string, path: string) =>
      h.request(
        path,
        {
          method,
          headers: { 'content-type': 'application/json' },
          body: method === 'DELETE' ? undefined : '{}',
        },
        SCRIPT,
      );
    for (const [method, path] of [
      ['PUT', '//credentials/anthropic'],
      ['PUT', '/credentials//anthropic'],
      ['PUT', '/credentials/anthropic/'],
      ['PUT', '/./credentials/anthropic'],
      ['POST', '//setup/complete'],
      ['POST', '/setup//complete/'],
      ['PUT', '/routing//chat'],
      ['POST', '//automations'],
      ['POST', '/automations//aut_1/run'],
      ['POST', '/threads//trash/empty'],
    ] as const) {
      const res = await sent(method, path);
      expect([403, 404], `${method} ${path}`).toContain(res.status);
    }
    expect(((await (await get('/permissions/preset', SCRIPT)).json()) as { preset: string }).preset).toBe(
      'balanced',
    );
  });
});

describe('which routes are open, key-only and session-only', () => {
  it('opens nothing but the pairing route', () => {
    expect(accessFor('GET', '/api/v1/session/pair')).toBe('open');
    expect(accessFor('GET', '/session/pair/')).toBe('open');
    // A change to it is not the pairing route.
    expect(accessFor('POST', '/session/pair')).toBe('any');
    for (const p of ['/system/health', '/threads', '/notebooks', '/memory/files', '/license', '/events'])
      expect(accessFor('GET', p), p).toBe('any');
  });

  it('minting a code takes the key', () => {
    expect(accessFor('POST', '/session/pair-codes')).toBe('key');
  });

  it('sends approvals, grants, permissions, scopes, privacy, MCP servers and Auto to the browser', () => {
    const session: [string, string][] = [
      ['GET', '/approvals'],
      ['POST', '/approvals/apr_1'],
      ['POST', '/approvals/batch'],
      ['GET', '/grants'],
      ['PATCH', '/grants/gnt_1'],
      ['DELETE', '/grants/gnt_1'],
      ['POST', '/grants/gnt_1/restore'],
      ['PUT', '/permissions/preset'],
      ['POST', '/auto/plans'],
      ['GET', '/auto/plans/current'],
      ['POST', '/auto/plans/pln_1/decision'],
      ['PATCH', '/notebooks/nbk_1/scope'],
      ['PATCH', '/threads/thr_1/scope'],
      ['POST', '/tool-presets'],
      ['PATCH', '/tool-presets/tp_1'],
      ['DELETE', '/tool-presets/tp_1'],
      ['PUT', '/privacy/policy'],
      ['POST', '/mcp/servers'],
      ['PATCH', '/mcp/servers/srv_1'],
      ['DELETE', '/mcp/servers/srv_1'],
      ['POST', '/mcp/servers/srv_1/test'],
      ['POST', '/mcp/presets/github/add'],
      ['POST', '/mcp/approvals/key/approve'],
      ['PATCH', '/mcp/servers/srv_1/tools/t'],
      ['POST', '/mcp/clients'],
      ['DELETE', '/mcp/clients/c1'],
      ['POST', '/claude-code/mcp-servers'],
      ['DELETE', '/claude-code/mcp-servers/x'],
      ['POST', '/memory/proposals/mp_1'],
      ['POST', '/memory/imports/mi_1/decide'],
      // Written another way.
      ['POST', '//approvals/apr_1'],
      ['POST', '/api/v1//grants/gnt_1/restore'],
      ['PUT', '/privacy/policy/'],
    ];
    for (const [m, p] of session) expect(accessFor(m, p), `${m} ${p}`).toBe('session');
  });

  it('leaves reading scopes, privacy and MCP servers to a script with the key', () => {
    for (const [m, p] of [
      ['GET', '/notebooks/nbk_1/scope'],
      ['GET', '/threads/thr_1/scope/effective'],
      ['GET', '/tool-presets'],
      ['GET', '/privacy/policy'],
      ['GET', '/mcp/servers'],
      ['GET', '/permissions/preset'],
      ['GET', '/permissions/decisions'],
    ] as const)
      expect(accessFor(m, p), `${m} ${p}`).toBe('any');
  });

  it('cleans a path the way the router reads it', () => {
    expect(cleanPath('/api/v1//a//b/./c')).toBe('/a/b/c');
    expect(cleanPath('/api/v1')).toBe('/');
  });
});

/**
 * The rule: a change to where data goes, to what agents may do or to what runs unattended, and a
 * deletion in bulk, is the paired browser's. Each entry is [method, address]; the address may carry
 * the query that makes a route dangerous.
 */
const SESSION_ONLY_CHANGES: [string, string][] = [
  // where data goes
  ['PUT', '/credentials/anthropic'],
  ['DELETE', '/credentials/anthropic'],
  ['PUT', '/credentials/anthropic/plan-credit'],
  ['PUT', '/github/token'],
  ['POST', '/models'],
  ['POST', '/models/catalogue'],
  ['PUT', '/models/openai/gpt-5'],
  ['PATCH', '/models/custom/my-endpoint'],
  ['DELETE', '/models/custom/my-endpoint'],
  ['POST', '/models/restore'],
  ['PUT', '/models/watch/settings'],
  ['POST', '/models/watch/add'],
  ['PUT', '/models/lines/anthropic/opus'],
  ['PUT', '/routing/chat'],
  ['DELETE', '/routing/chat'],
  ['PUT', '/routing/credit-first'],
  ['PUT', '/openrouter/routing'],
  ['PUT', '/compute/provider'],
  ['DELETE', '/compute/provider'],
  ['POST', '/setup/providers/test'],
  ['POST', '/setup/complete'],
  // what runs unattended, and what only the window does
  ['POST', '/automations'],
  ['PATCH', '/automations/aut_1'],
  ['POST', '/automations/aut_1/run'],
  ['POST', '/automations/aut_1/test'],
  ['POST', '/automations/aut_1/reset'],
  ['DELETE', '/automations/aut_1'],
  ['PATCH', '/claude-code/settings'],
  ['POST', '/claude-code/sign-in'],
  ['POST', '/claude-code/sign-out'],
  ['POST', '/claude-code/install'],
  ['PUT', '/claude-code/projects'],
  ['POST', '/claude-code/projects/exclude'],
  ['DELETE', '/claude-code/projects'],
  ['POST', '/claude-code/threads/thr_1/folder'],
  ['PUT', '/lab/settings'],
  ['POST', '/interpreter/requests/req_1/claim'],
  ['POST', '/interpreter/requests/req_1/result'],
  // licence, sync, data safety
  ['POST', '/license/activate'],
  ['POST', '/license/deactivate'],
  ['POST', '/license/refresh'],
  ['PUT', '/pro/sync/settings'],
  ['POST', '/pro/sync/devices/dev_1/approve'],
  ['DELETE', '/pro/sync/devices/dev_1'],
  ['POST', '/pro/licence/refresh'],
  ['POST', '/system/restore/stage'],
  ['POST', '/system/restore/apply'],
  ['DELETE', '/system/restore'],
  ['POST', '/system/startup/restore'],
  ['POST', '/system/tidy'],
  ['POST', '/threads/trash/empty'],
  // deleting a notebook with everything in it
  ['DELETE', '/notebooks/nbk_1?contents=delete'],
  ['DELETE', '/notebooks/nbk_1?sources=delete'],
  ['DELETE', '/notebooks/nbk_1?contents=DELETE'],
  ['DELETE', '/notebooks/nbk_1/?contents=delete&x=1'],
  // written another way
  ['POST', '//setup/complete'],
  ['PUT', '/api/v1//credentials//anthropic'],
  ['POST', '/api/v1/./automations/'],
  ['DELETE', '//notebooks/nbk_1/?contents=delete'],
  ['PUT', '/credentials/anthropic/'],
];

/** What a script with the install key still does: read, and the changes that only move work along. */
const KEY_IS_ENOUGH: [string, string][] = [
  ['GET', '/credentials'],
  ['GET', '/credentials/anthropic'],
  ['GET', '/models'],
  ['GET', '/models/watch/settings'],
  ['GET', '/routing'],
  ['GET', '/openrouter/routing'],
  ['GET', '/compute/provider'],
  ['GET', '/setup/status'],
  ['GET', '/automations'],
  ['GET', '/automations/aut_1'],
  ['GET', '/claude-code/settings'],
  ['GET', '/claude-code/projects'],
  ['GET', '/lab/settings'],
  ['GET', '/license'],
  ['GET', '/pro/sync/devices'],
  ['GET', '/system/restore'],
  ['GET', '/system/tidy'],
  ['GET', '/threads/trash'],
  ['GET', '/notebooks/nbk_1?contents=delete'],
  // Deleting a notebook the gentle way goes to the Trash.
  ['DELETE', '/notebooks/nbk_1'],
  ['DELETE', '/notebooks/nbk_1?contents=keep'],
  ['DELETE', '/notebooks/nbk_1/sources/src_1'],
  ['DELETE', '/threads/thr_1'],
  // Restarting a service and the work a script does with the key.
  ['POST', '/system/services/core/restart'],
  ['POST', '/system/backups'],
  ['POST', '/threads'],
  ['POST', '/notebooks'],
  ['POST', '/pro/team/members'],
  ['POST', '/pro/fleet/groups'],
];

const parts = (address: string) => {
  const [path = '', search = ''] = address.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(search)) };
};

describe('which changes are the paired browser’s alone', () => {
  it('lists every change that moves data, widens what agents may do, runs unattended or deletes in bulk', () => {
    for (const [m, address] of SESSION_ONLY_CHANGES) {
      const { path, query } = parts(address);
      expect(accessFor(m, path, query), `${m} ${address}`).toBe('session');
    }
  });

  it('leaves reading them, and the work a script does, to the install key', () => {
    for (const [m, address] of KEY_IS_ENOUGH) {
      const { path, query } = parts(address);
      expect(accessFor(m, path, query), `${m} ${address}`).toBe('any');
    }
  });

  it('asks the query only of the notebook route, and only for a delete with its contents', () => {
    expect(accessFor('DELETE', '/notebooks/nbk_1', { contents: 'delete' })).toBe('session');
    expect(accessFor('DELETE', '/notebooks/nbk_1', { sources: 'delete' })).toBe('session');
    expect(accessFor('DELETE', '/notebooks/nbk_1', { contents: 'keep', sources: 'keep' })).toBe('any');
    expect(accessFor('DELETE', '/notebooks/nbk_1')).toBe('any');
    expect(accessFor('GET', '/notebooks/nbk_1', { contents: 'delete' })).toBe('any');
    expect(accessFor('DELETE', '/threads/thr_1', { contents: 'delete' })).toBe('any');
  });
});

/** An app that is only the guard in front of a route that answers 200, so every address can be tried. */
function guardedStub() {
  const auth = testLocalAuth();
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  const api = new Hono<AppEnv>();
  api.use('*', requestGuard({ origins: [COCKPIT_ORIGIN], auth }));
  api.all('*', (c) => c.json({ reached: true }));
  app.route('/api/v1', api);
  const call = (method: string, address: string, who: Credentials) =>
    app.request(address.startsWith('/api/v1') ? address : `/api/v1${address}`, {
      method,
      headers: headersFor(auth, who),
    });
  return { call };
}

describe('the guard holds for every one of them', () => {
  const { call } = guardedStub();

  it('turns away a script with the install key, whatever it adds to the request', async () => {
    for (const [m, address] of SESSION_ONLY_CHANGES) {
      const res = await call(m, address, SCRIPT);
      expect(res.status, `${m} ${address}`).toBe(403);
      expect((await errorOf(res)).code, `${m} ${address}`).toBe('auth.browser_session_required');
    }
    // Naming the Cockpit as its origin does not make a script a browser.
    for (const [m, address] of SESSION_ONLY_CHANGES) {
      const res = await call(m, address, { ...SCRIPT, origin: COCKPIT_ORIGIN });
      expect(res.status, `${m} ${address}`).toBe(403);
    }
  });

  it('turns away a request with nothing, and a browser cookie that names no Origin', async () => {
    for (const [m, address] of SESSION_ONLY_CHANGES) {
      expect((await call(m, address, {})).status, `${m} ${address}`).toBe(401);
      expect((await call(m, address, { cookie: true })).status, `${m} ${address}`).toBe(403);
    }
  });

  it('lets the paired browser through', async () => {
    for (const [m, address] of SESSION_ONLY_CHANGES) {
      const res = await call(m, address, BROWSER);
      expect(res.status, `${m} ${address}`).toBe(200);
    }
  });

  it('lets a script read and work with the key alone', async () => {
    for (const [m, address] of KEY_IS_ENOUGH) {
      const res = await call(m, address, SCRIPT);
      expect(res.status, `${m} ${address}`).toBe(200);
    }
  });
});

describe('the real routes behind the guard', () => {
  const put = (path: string, who: Credentials, body: unknown = {}) =>
    h.request(
      path,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      who,
    );

  it('refuse a key written, a model route changed and setup finished by a script, and change nothing', async () => {
    h = await harness({ ops: true });
    const before = await (await get('/credentials', SCRIPT)).json();

    const key = await put('/credentials/anthropic', SCRIPT, { value: 'sk-ant-test-value' });
    expect(key.status).toBe(403);
    expect((await errorOf(key)).code).toBe('auth.browser_session_required');
    expect((await put('/routing/chat', SCRIPT, { chain: [] })).status).toBe(403);
    expect((await put('/github/token', SCRIPT, { token: 'ghp_test' })).status).toBe(403);
    expect((await post('/setup/complete', SCRIPT, { preset: 'hands_off' })).status).toBe(403);
    expect((await post('/setup/providers/test', SCRIPT, { provider: 'openai' })).status).toBe(403);
    expect((await post('/automations', SCRIPT, { name: 'x' })).status).toBe(403);
    expect((await post('/threads/trash/empty', SCRIPT)).status).toBe(403);

    expect(await (await get('/credentials', SCRIPT)).json()).toEqual(before);
    expect(((await (await get('/permissions/preset', SCRIPT)).json()) as { preset: string }).preset).toBe(
      'balanced',
    );
  });

  it('still answer a script that reads', async () => {
    h = await harness({ ops: true });
    for (const path of ['/credentials', '/models', '/routing', '/automations', '/threads/trash'])
      expect((await get(path, SCRIPT)).status, path).toBe(200);
  });

  it('answer the paired browser, which reaches the handler', async () => {
    h = await harness({ ops: true });
    const key = await put('/credentials/anthropic', BROWSER, { value: 'not-a-real-key' });
    expect([401, 403]).not.toContain(key.status);
    const done = await post('/setup/complete', BROWSER, { preset: 'balanced' });
    expect([401, 403]).not.toContain(done.status);
  });
});

describe('Pro sync is the paired browser’s, found by feature', () => {
  /** Pro's routes behind the real guard: Pro's own paths are private, so a route is known by its feature. */
  function proApp(routes: ProRoute[]) {
    const auth = testLocalAuth();
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    const api = new Hono<AppEnv>();
    api.use('*', requestGuard({ origins: [COCKPIT_ORIGIN], auth }));
    api.route('/', proRoutes({ routes, hasFeature: () => true, seams: [] }));
    app.route('/api/v1', api);
    return (method: string, path: string, who: Credentials) =>
      app.request(`/api/v1${path}`, { method, headers: headersFor(auth, who) });
  }
  const ok = async () => ({ body: { ok: true } });
  const routes: ProRoute[] = [
    { method: 'GET', path: '/elsewhere/devices', feature: 'sync', public: true, handler: ok },
    { method: 'POST', path: '/anything/at/all', feature: 'sync', public: true, handler: ok },
    { method: 'DELETE', path: '/some/thing/:id', feature: 'sync', public: true, handler: ok },
    { method: 'POST', path: '/beam/x', feature: 'beam', public: true, handler: ok },
    { method: 'POST', path: '/fleet/groups', feature: 'fleet', public: true, handler: ok },
  ];

  it('refuses any change to a route of the sync feature for a script, wherever its path is', async () => {
    const call = proApp(routes);
    for (const [m, p] of [
      ['POST', '/pro/anything/at/all'],
      ['DELETE', '/pro/some/thing/dev_1'],
    ]) {
      const res = await call(m as string, p as string, SCRIPT);
      expect(res.status, `${m} ${p}`).toBe(403);
      expect((await errorOf(res)).code).toBe('auth.browser_session_required');
      // A cookie with no Origin is a script that borrowed one.
      expect((await call(m as string, p as string, { cookie: true })).status, `${m} ${p}`).toBe(403);
      expect((await call(m as string, p as string, BROWSER)).status, `${m} ${p}`).toBeLessThan(300);
    }
  });

  it('leaves reading sync, and the other Pro features, to a script with the key', async () => {
    const call = proApp(routes);
    expect((await call('GET', '/pro/elsewhere/devices', SCRIPT)).status).toBe(200);
    expect((await call('POST', '/pro/beam/x', SCRIPT)).status).toBe(200);
    expect((await call('POST', '/pro/fleet/groups', SCRIPT)).status).toBe(200);
  });
});

describe('pairing a browser', () => {
  const pair = async (code: string, extra: Record<string, string> = {}, query = '') =>
    h.app.request(`/api/v1/session/pair?code=${encodeURIComponent(code)}${query}`, { headers: extra });

  it('takes the key to ask for a code, not a cookie and not nothing', async () => {
    h = await harness();
    expect((await post('/session/pair-codes', {})).status).toBe(401);
    expect((await post('/session/pair-codes', BROWSER)).status).toBe(401);
    const res = await post('/session/pair-codes', SCRIPT);
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { code: string; expires_in_s: number };
    expect(body.code.length).toBeGreaterThanOrEqual(32);
    expect(body.expires_in_s).toBe(60);
    expect(body.code).not.toContain(LOCAL_KEY);
  });

  it('spends a code once: a 303 to the Cockpit with an HttpOnly, SameSite=Strict cookie that is not the key', async () => {
    h = await harness();
    const { code } = (await (await post('/session/pair-codes', SCRIPT)).json()) as { code: string };
    const res = await pair(code);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^ancile_session_7700=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${400 * 24 * 60 * 60}`);
    expect(cookie).not.toContain('Secure');
    expect(cookie).not.toContain(LOCAL_KEY);
    // The cookie it set is the browser's way in.
    const browser = (cookie.split(';')[0] ?? '').trim();
    const read = await h.app.request('/api/v1/threads', { headers: { cookie: browser } });
    expect(read.status).toBe(200);
    // The same code does nothing the second time.
    const again = await pair(code);
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toBe('/?pair=failed');
    expect(again.headers.get('set-cookie')).toBeNull();
  });

  it('sends a wrong, missing or unknown code back to the Cockpit with no cookie', async () => {
    h = await harness();
    for (const code of ['', 'x', 'A'.repeat(43), LOCAL_KEY]) {
      const res = await pair(code);
      expect(res.status, code).toBe(303);
      expect(res.headers.get('location')).toBe('/?pair=failed');
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    const none = await h.app.request('/api/v1/session/pair');
    expect(none.headers.get('location')).toBe('/?pair=failed');
  });

  it('does not take the install key itself as a way in, so it is never in an address', async () => {
    h = await harness();
    const res = await h.app.request(`/api/v1/session/pair?key=${LOCAL_KEY}`);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('location')).toBe('/?pair=failed');
  });

  it('marks the cookie Secure behind https, and only goes on to a path on this site', async () => {
    h = await harness();
    const mint = async () =>
      ((await (await post('/session/pair-codes', SCRIPT)).json()) as { code: string }).code;
    const tls = await pair(await mint(), { 'x-forwarded-proto': 'https' });
    expect(tls.headers.get('set-cookie')).toContain('Secure');
    const next = await pair(await mint(), {}, '&next=/notebooks');
    expect(next.headers.get('location')).toBe('/notebooks');
    for (const bad of [
      '//evil.example',
      'https://evil.example',
      '/\\evil.example',
      '/x\r\nset-cookie: a=b',
    ]) {
      const res = await pair(await mint(), {}, `&next=${encodeURIComponent(bad)}`);
      expect(res.headers.get('location'), bad).toBe('/');
    }
  });

  it('lets a code live 60 seconds and no longer, and keeps no more than a few waiting', () => {
    let now = 1_000_000;
    const auth = testLocalAuth({ now: () => now });
    const { code } = auth.mintPairCode();
    now += 59_000;
    expect(auth.redeemPairCode(code)).toBe(true);
    const late = auth.mintPairCode();
    now += 61_000;
    expect(auth.redeemPairCode(late.code)).toBe(false);
    const first = auth.mintPairCode();
    for (let i = 0; i < 25; i++) auth.mintPairCode();
    expect(auth.redeemPairCode(first.code)).toBe(false);
  });

  it('chooses the next page only on this site', () => {
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext('/threads?x=1')).toBe('/threads?x=1');
    expect(safeNext('/api/v1/session/pair?code=a')).toBe('/');
    expect(safeNext('//evil.example')).toBe('/');
  });
});

describe('the key never leaves Core', () => {
  it('is taken out of any text that mentions it, wherever it turns up', () => {
    registerSecret(LOCAL_KEY);
    expect(redactText(`failed with ${LOCAL_KEY} in the url`)).not.toContain(LOCAL_KEY);
  });

  it('is not in the cookie, and the cookie is not usable as the key', async () => {
    h = await harness();
    const cookieValue = h.localAuth.setCookie(false).split(';')[0]?.split('=')[1] ?? '';
    expect(cookieValue).not.toBe(LOCAL_KEY);
    const asBearer = await get('/threads', { bearer: cookieValue });
    expect(asBearer.status).toBe(401);
  });

  it("is left out of Core's health probes, which stay open for the supervisor", async () => {
    h = await harness();
    expect((await h.app.request('/health')).status).toBe(200);
    expect((await h.app.request('/ready')).status).toBe(200);
  });
});
