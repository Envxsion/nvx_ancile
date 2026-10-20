/**
 * The verdict cache (SI1): the key follows the claim and the sources, lifetimes follow what backed the
 * verdict, verdicts stay in their notebook until you share them, your own sources never leave, a
 * private notebook shares only when the setting allows, and sharing can be undone in one step.
 */
import type { PrivacyCapability } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import {
  type CachedVerdict,
  cacheKey,
  MemoryVerdictCacheStore,
  normaliseClaim,
  RULES_TTL_MS,
  VerdictCache,
  WEB_TTL_MS,
} from '../../src/factcheck/cache';

const verdict: CachedVerdict = {
  stance: 'supported',
  rationale: 'ok',
  evidence: [],
  confidence: 0.9,
  general: false,
};
const src = (ref: string, text = 'passage') => ({ origin: 'source' as const, ref, quote: text, text });
const web = (ref: string, text = 'snippet') => ({ origin: 'web' as const, ref, quote: text, text });

function make(opts: { privateOk?: boolean; now?: () => Date } = {}) {
  const store = new MemoryVerdictCacheStore();
  const asked: { capability: PrivacyCapability; notebookId?: string | null }[] = [];
  const cache = new VerdictCache(
    store,
    {
      allows: async (capability, ctx) => {
        asked.push({ capability, notebookId: ctx.notebookId });
        return opts.privateOk !== false;
      },
    },
    opts.now,
  );
  return { store, cache, asked };
}

const rec = (cache: VerdictCache, a: Partial<Parameters<VerdictCache['record']>[0]> & { claim: string }) =>
  cache.record({
    notebookId: 'nb1',
    shared: false,
    evidence: [],
    critical: false,
    verdict,
    tier: 'tiny',
    modelId: 'm/tiny',
    ...a,
  });
const find = (cache: VerdictCache, a: Partial<Parameters<VerdictCache['lookup']>[0]> & { claim: string }) =>
  cache.lookup({ notebookId: 'nb1', shared: false, evidence: [], critical: false, ...a });

describe('the key', () => {
  it('ignores case, spacing and end punctuation', () => {
    const k = (c: string) => cacheKey({ claim: c, evidence: [], critical: false }).key;
    expect(k('The sky is blue.')).toBe(k('  the SKY   is blue '));
    expect(k('The sky is blue.')).not.toBe(k('The sky is green.'));
    expect(normaliseClaim('Is it?!')).toBe('is it');
  });

  it('follows the sources: a changed passage is a new key, the order of sources is not', () => {
    const k = (ev: ReturnType<typeof src>[]) => cacheKey({ claim: 'c', evidence: ev, critical: false }).key;
    expect(k([src('a'), src('b')])).toBe(k([src('b'), src('a')]));
    expect(k([src('a', 'old')])).not.toBe(k([src('a', 'new')]));
  });

  it('keeps critical checks apart from ordinary ones', () => {
    const k = (critical: boolean) => cacheKey({ claim: 'c', evidence: [], critical }).key;
    expect(k(true)).not.toBe(k(false));
  });

  it('knows the web from your sources and from nothing', () => {
    expect(cacheKey({ claim: 'c', evidence: [src('a')], critical: false }).basis).toBe('sources');
    expect(cacheKey({ claim: 'c', evidence: [web('u')], critical: false }).basis).toBe('web');
    expect(cacheKey({ claim: 'c', evidence: [], critical: false }).basis).toBe('general');
    // A web snippet that is worded differently today is the same page.
    const k = (t: string) => cacheKey({ claim: 'c', evidence: [web('https://x', t)], critical: false }).key;
    expect(k('one')).toBe(k('two'));
  });
});

describe('lifetimes', () => {
  it('keeps a source-backed verdict until a source changes; the web for a week; common knowledge for 90 days', async () => {
    let now = new Date('2026-10-20T00:00:00Z');
    const { cache, store } = make({ now: () => now });
    await rec(cache, { claim: 'a', evidence: [src('s1')] });
    await rec(cache, { claim: 'b', evidence: [web('u')] });
    await rec(cache, { claim: 'c' });
    const ttl = [...store.rows.values()].map((r) => [r.ttl_kind, r.expires_at]);
    expect(ttl).toEqual([
      ['source', null],
      ['web', new Date(now.getTime() + WEB_TTL_MS).toISOString()],
      ['rules', new Date(now.getTime() + RULES_TTL_MS).toISOString()],
    ]);
    const hit = (claim: string, evidence: Parameters<VerdictCache['lookup']>[0]['evidence']) =>
      find(cache, { claim, evidence });
    now = new Date(now.getTime() + 8 * 86_400_000);
    expect(await hit('a', [src('s1')])).not.toBeNull();
    expect(await hit('b', [web('u')])).toBeNull();
    expect(await hit('c', [])).not.toBeNull();
    now = new Date(now.getTime() + 90 * 86_400_000);
    expect(await hit('c', [])).toBeNull();
    expect(await hit('a', [src('s1')])).not.toBeNull();
  });

  it('never finds a source-backed verdict once the passage has changed', async () => {
    const { cache } = make();
    await rec(cache, { claim: 'a', evidence: [src('s1', 'before')] });
    expect(await find(cache, { claim: 'a', evidence: [src('s1', 'before')] })).not.toBeNull();
    expect(await find(cache, { claim: 'a', evidence: [src('s1', 'after')] })).toBeNull();
  });
});

describe('scope', () => {
  it('keeps a verdict in its own notebook by default', async () => {
    const { cache } = make();
    await rec(cache, { claim: 'sky' });
    expect(await find(cache, { claim: 'sky' })).toMatchObject({ scope: 'notebook' });
    expect(await find(cache, { claim: 'sky', notebookId: 'nb2', shared: true })).toBeNull();
  });

  it('shares in one step, only what never used your sources, and reverts in one step', async () => {
    const { cache, store } = make();
    await rec(cache, { claim: 'sky' });
    await rec(cache, { claim: 'mine', evidence: [src('s1')] });
    await rec(cache, { claim: 'web', evidence: [web('u')] });
    expect(await cache.setShared('nb1', true)).toBe(2);
    const scopes = Object.fromEntries(
      [...store.rows.values()].map((r) => [r.verdict.stance + r.mode, r.scope]),
    );
    expect(scopes).toEqual({
      supportedgeneral: 'global',
      supportedsources: 'notebook',
      supportedweb: 'global',
    });
    // Another notebook that shares too gets the global verdict; one that does not, does not.
    expect(await find(cache, { claim: 'sky', notebookId: 'nb2', shared: true })).toMatchObject({
      scope: 'global',
    });
    expect(await find(cache, { claim: 'sky', notebookId: 'nb2', shared: false })).toBeNull();
    // Your own sources never leave the notebook, shared or not.
    expect(
      await find(cache, { claim: 'mine', evidence: [src('s1')], notebookId: 'nb2', shared: true }),
    ).toBeNull();
    // Stop sharing: the global copies are withdrawn.
    expect(await cache.setShared('nb1', false)).toBe(2);
    expect(await find(cache, { claim: 'sky', notebookId: 'nb2', shared: true })).toBeNull();
    expect(await find(cache, { claim: 'sky' })).toMatchObject({ scope: 'notebook' });
  });

  it('records a new verdict straight to global while the notebook shares', async () => {
    const { cache } = make();
    await rec(cache, { claim: 'sky', shared: true });
    await rec(cache, { claim: 'mine', shared: true, evidence: [src('s1')] });
    expect(await find(cache, { claim: 'sky', notebookId: 'nb9', shared: true })).toMatchObject({
      scope: 'global',
    });
    expect(
      await find(cache, { claim: 'mine', evidence: [src('s1')], notebookId: 'nb9', shared: true }),
    ).toBeNull();
  });

  it('asks the privacy policy before a notebook gives or takes global verdicts', async () => {
    const closed = make({ privateOk: false });
    await rec(closed.cache, { claim: 'sky', shared: true });
    expect(await find(closed.cache, { claim: 'sky' })).toMatchObject({ scope: 'notebook' });
    expect(closed.asked.at(0)).toEqual({ capability: 'verdict_cache_global', notebookId: 'nb1' });
    expect(await closed.cache.mayShare('nb1')).toBe(false);
    // Another notebook's global verdict is not read by a private notebook either.
    const open = make();
    await rec(open.cache, { claim: 'sky', notebookId: 'nb0', shared: true });
    const closedReader = new VerdictCache(open.store, { allows: async () => false });
    expect(
      await closedReader.lookup({
        notebookId: 'nb1',
        shared: true,
        claim: 'sky',
        evidence: [],
        critical: false,
      }),
    ).toBeNull();
  });

  it('forgets a notebook on request', async () => {
    const { cache } = make();
    await rec(cache, { claim: 'sky' });
    expect(await cache.entries('nb1')).toBe(1);
    await cache.clear('nb1');
    expect(await cache.entries('nb1')).toBe(0);
  });
});
