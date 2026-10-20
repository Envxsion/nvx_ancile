/**
 * The verdict cache and the notebook's life (SI1, D29): deleting a notebook deletes its checked claims,
 * the ones it shared included; turning on Private withdraws what it shared at once and stops it giving or
 * taking global verdicts; and the decision layer's claim sorter may raise a tier, never lower one, and
 * never blocks.
 */
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { Decider } from '../../src/decisions/ask';
import { decisionTriage } from '../../src/decisions/ask';
import { MemoryVerdictCacheStore, VerdictCache } from '../../src/factcheck/cache';
import {
  DECISION_TRIAGE_TIERS,
  fromDecisions,
  setTriageProvider,
  triageClaims,
} from '../../src/factcheck/triage';
import { MemoryNotebookRepo } from '../../src/notebooks/repo';
import { notebookRoutes } from '../../src/notebooks/routes';
import { errorHandler } from '../../src/obs/errors';
import { scopeRoutes } from '../../src/scopes/routes';
import { MemoryScopeStore } from '../../src/scopes/store';
import { MemoryThreadRepo } from '../../src/threads/repo';

const verdict = { stance: 'supported' as const, rationale: '', evidence: [], confidence: 0.9, general: true };
const WS = 'wsp_test';

function rec(cache: VerdictCache, notebookId: string, shared: boolean, claim = 'The sky is blue.') {
  return cache.record({
    notebookId,
    shared,
    claim,
    evidence: [],
    critical: false,
    verdict,
    tier: 'tiny',
    modelId: 'm/tiny',
  });
}
const find = (cache: VerdictCache, notebookId: string, shared = true) =>
  cache.lookup({ notebookId, shared, claim: 'The sky is blue.', evidence: [], critical: false });

describe('a notebook’s verdicts and the notebook', () => {
  it('deleting a notebook deletes its verdicts, the global ones it contributed too', async () => {
    const cache = new VerdictCache(new MemoryVerdictCacheStore());
    const notebooks = new MemoryNotebookRepo();
    await notebooks.create({ id: 'nb1', workspace_id: WS, title: 'One' });
    await notebooks.create({ id: 'nb2', workspace_id: WS, title: 'Two' });
    await rec(cache, 'nb1', true);
    await rec(cache, 'nb2', false, 'Water is wet.');
    expect(await find(cache, 'nb2')).toMatchObject({ scope: 'global' });
    const app = new Hono();
    app.onError(errorHandler);
    app.route(
      '/',
      notebookRoutes({
        workspaceId: WS,
        notebooks,
        threads: new MemoryThreadRepo(),
        kn: { get: async () => [], del: async () => undefined } as never,
        verdictCache: cache,
      }) as unknown as Hono,
    );
    expect((await app.request('/notebooks/nb1', { method: 'DELETE' })).status).toBe(204);
    expect(await cache.entries('nb1')).toBe(0);
    expect(await find(cache, 'nb2')).toBeNull();
    // The other notebook keeps its own.
    expect(await cache.entries('nb2')).toBe(1);
  });

  it('turning on Private withdraws what the notebook shared, at once', async () => {
    const store = new MemoryScopeStore();
    store.notebooks.add('nb1');
    const cache = new VerdictCache(new MemoryVerdictCacheStore());
    await rec(cache, 'nb1', true);
    expect(await find(cache, 'nb9')).toMatchObject({ scope: 'global' });
    const app = new Hono();
    app.onError(errorHandler);
    app.route(
      '/',
      scopeRoutes({
        store,
        onPrivate: async (id) => void (await cache.setShared(id, false)),
      }) as unknown as Hono,
    );
    const res = await app.request('/notebooks/nb1/scope', {
      method: 'PATCH',
      body: JSON.stringify({ private: true }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(await find(cache, 'nb9')).toBeNull();
    expect(await find(cache, 'nb1', false)).toMatchObject({ scope: 'notebook' });
  });

  it('a private notebook neither gives nor takes global verdicts while the setting is off', async () => {
    const store = new MemoryVerdictCacheStore();
    const open = new VerdictCache(store);
    await rec(open, 'nb0', true);
    // The same store seen by a notebook that has since become private.
    const closed = new VerdictCache(store, { allows: async () => false });
    expect(await find(closed, 'nb1')).toBeNull();
    await rec(closed, 'nb1', true);
    expect([...store.rows.values()].find((r) => r.notebook_id === 'nb1')?.scope).toBe('notebook');
  });
});

describe('the decision layer’s claim sorter', () => {
  afterEach(() => setTriageProvider(null));

  /** A fake decisions router that answers each claim question with the label for its text. */
  const router = (label: (claim: string) => string | null, ok = true): Decider & { seen: object[] } => {
    const seen: object[] = [];
    return {
      seen,
      decide: (async (
        _task: string,
        req: { questions: Record<string, { instructions: string }> },
        ctx: object,
      ) => {
        seen.push(ctx);
        if (!ok) return { ok: false, reason: 'none', tried: [] };
        const answers: Record<string, unknown> = {};
        for (const [k, q] of Object.entries(req.questions)) {
          const l = label(q.instructions);
          if (l) answers[k] = { type: 'choice', choice: l, confidence: 0.9, probabilities: { [l]: 0.9 } };
        }
        return { ok: true, answers, receipt: {}, tried: [] };
      }) as never,
    };
  };
  const wire = (r: Decider) =>
    setTriageProvider(
      fromDecisions((ctx) =>
        decisionTriage(r, {
          tiers: DECISION_TRIAGE_TIERS,
          fallbackTier: 'rules',
          ctx: { notebookId: ctx.notebookId ?? null },
        }),
      ),
    );

  it('raises a tier, never lowers one, and passes the notebook for privacy', async () => {
    const r = router((q) => (q.includes('sky') ? 'careful' : 'obvious'));
    wire(r);
    const out = await triageClaims(['The sky is blue.', 'The pump failed after 14 hours.'], {
      critical: false,
      notebookId: 'nb1',
    });
    // Rules said tiny; the decision layer raised it. Rules said standard; "obvious" cannot lower it.
    expect(out.map((t) => t.tier)).toEqual(['balanced', 'balanced']);
    expect(out[0]?.critical).toBe(true);
    expect(out[1]?.obvious).toBe(false);
    expect(r.seen[0]).toMatchObject({ notebookId: 'nb1' });
  });

  it('never blocks: with no decision model, or an answer that does not fit, the rules decide', async () => {
    wire(router(() => null, false));
    const none = await triageClaims(['The sky is blue.'], { critical: false });
    expect(none[0]).toMatchObject({ tier: 'tiny', obvious: true });
    wire(router(() => 'nonsense'));
    const odd = await triageClaims(['The sky is blue.'], { critical: false });
    expect(odd[0]).toMatchObject({ tier: 'tiny', obvious: true });
  });

  it('is not asked in a critical notebook', async () => {
    const r = router(() => 'obvious');
    wire(r);
    await triageClaims(['The sky is blue.'], { critical: true });
    expect(r.seen).toHaveLength(0);
  });
});
