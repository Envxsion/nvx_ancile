/**
 * Private-notebook policy (docs/privacy.md): defaults, switching a capability on,
 * a local model counting as private, the floors staying locked, and the routes.
 */
import { DEFAULT_PRIVACY_POLICY } from '@nvx/contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../../src/obs/errors';
import { allowsByDefault, allowsUnder, PrivacyPolicies } from '../../src/privacy/policy';
import { privacyRoutes } from '../../src/privacy/routes';
import { MemorySettings } from '../../src/settings';

const make = (opts: { priv?: string[]; local?: boolean } = {}) =>
  new PrivacyPolicies({
    settings: new MemorySettings(),
    isPrivate: async (id) => (opts.priv ?? ['nb_priv']).includes(id),
    localAvailable: () => opts.local ?? false,
  });

describe('privacy policy', () => {
  it('defaults every switchable capability to off in private notebooks', () => {
    expect(DEFAULT_PRIVACY_POLICY).toEqual({
      decisions_off_machine: { allowed_in_private: false },
      passive_memory: { allowed_in_private: false },
      verdict_cache_global: { allowed_in_private: false },
    });
  });

  it('allows everything in a notebook that is not private', async () => {
    const p = make();
    for (const c of ['decisions_off_machine', 'passive_memory', 'verdict_cache_global', 'web'] as const)
      expect(await p.allows(c, { notebookId: 'nb_open' })).toBe(true);
  });

  it('denies hosted decisions in a private notebook until switched on', async () => {
    const p = make();
    expect(await p.allows('decisions_off_machine', { notebookId: 'nb_priv' })).toBe(false);
    await p.update({ decisions_off_machine: { allowed_in_private: true } });
    const a = await p.resolve('decisions_off_machine', { notebookId: 'nb_priv' });
    expect(a).toMatchObject({ allowed: true, via: 'policy', must_run_local: false });
    await p.update({ decisions_off_machine: { allowed_in_private: false } });
    expect(await p.allows('decisions_off_machine', { private: true })).toBe(false);
  });

  it('a local call counts as private; a local model unlocks decisions and passive memory only', async () => {
    const p = make({ local: true });
    expect(await p.allows('decisions_off_machine', { private: true, local: true })).toBe(true);
    const a = await p.resolve('passive_memory', { notebookId: 'nb_priv' });
    expect(a).toMatchObject({ allowed: true, via: 'local_model', must_run_local: true });
    expect(await p.allows('verdict_cache_global', { private: true })).toBe(false);
    expect(await make().allows('passive_memory', { private: true })).toBe(false);
  });

  it('keeps the floors locked, except for a call on a local model', async () => {
    const p = make({ local: true });
    for (const c of ['claude_code', 'web'] as const) {
      expect(await p.allows(c, { private: true })).toBe(false);
      expect(await p.allows(c, { private: true, local: true })).toBe(false);
    }
    expect(allowsByDefault('auto_reviewer_off_machine', { private: true })).toBe(false);
    expect(allowsByDefault('auto_reviewer_off_machine', { private: true, local: true })).toBe(true);
    expect(allowsByDefault('cloud_models', { private: false })).toBe(true);
  });

  it('require throws privacy.denied with a hint', async () => {
    await expect(make().require('verdict_cache_global', { private: true })).rejects.toMatchObject({
      code: 'privacy.denied',
      status: 403,
    });
  });

  it('the pure rule agrees with the service', () => {
    expect(allowsUnder(DEFAULT_PRIVACY_POLICY, 'passive_memory', { private: true }).allowed).toBe(false);
  });
});

describe('privacy routes', () => {
  const app = (p: PrivacyPolicies) => {
    const a = new Hono();
    a.onError(errorHandler);
    a.route('/', privacyRoutes(p) as unknown as Hono);
    return a;
  };
  const put = (a: Hono, policy: unknown) =>
    a.request('/privacy/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy }),
    });

  it('lists a row for every capability and saves a toggle', async () => {
    const a = app(make());
    const got = (await (await a.request('/privacy/policy')).json()) as { rows: { id: string }[] };
    expect(got.rows.map((r) => r.id)).toEqual([
      'decisions_off_machine',
      'passive_memory',
      'verdict_cache_global',
      'cloud_models',
      'claude_code',
      'web',
      'auto_reviewer_off_machine',
    ]);
    const res = await put(a, { passive_memory: { allowed_in_private: true } });
    expect(res.status).toBe(200);
    const after = (await res.json()) as {
      policy: Record<string, { allowed_in_private: boolean }>;
    };
    expect(after.policy.passive_memory?.allowed_in_private).toBe(true);
    expect(after.policy.decisions_off_machine?.allowed_in_private).toBe(false);
  });

  it('refuses to switch a locked capability on', async () => {
    const res = await put(app(make()), { web: { allowed_in_private: true } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('privacy.locked');
  });
});
