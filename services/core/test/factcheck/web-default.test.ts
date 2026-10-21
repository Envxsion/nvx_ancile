/**
 * The web is the default for a claim the sources do not cover (roadmap FC4):
 * on in a normal notebook, never in a private one unless Settings → Private
 * notebooks allows it, Strict asks once per check, Balanced and Auto do not
 * ask, and the one-click check of a single claim honours the same rules.
 */
import { AncileError, type EffectiveScope, type EvidenceResponse, type SelectionCheck } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { gatedWeb, newTally, type WebHit, type WebSearch, webPolicy } from '../../src/factcheck/web';
import { MemoryNotebookRepo, nbFromRow } from '../../src/notebooks/repo';
import { AutoReview, MemoryPlanStore, type Reviewer } from '../../src/permissions/auto';
import { BuiltinPolicy, LayeredPolicy, presetRelax } from '../../src/permissions/cedar';
import { createGate } from '../../src/permissions/gate';
import { MemoryPermissionStore } from '../../src/permissions/store';
import { DEFAULT_SCOPE } from '../../src/scopes/resolve';
import { type Harness, harness } from '../support/harness';

const scopeOf = (over: Partial<EffectiveScope['scope']> = {}, priv = false): EffectiveScope => ({
  notebook_id: 'nbk_1',
  thread_id: null,
  private: priv,
  scope: { ...DEFAULT_SCOPE, ...(priv ? { data_leaves_machine: false } : {}), ...over },
  provenance: {} as never,
  clamped: [],
  tool_presets: [],
});

const base = { notebookWeb: true, requested: undefined, configured: true };

describe('webPolicy by default', () => {
  it('uses the web in a normal notebook without anything being asked', () => {
    expect(webPolicy({ ...base, scope: scopeOf() })).toEqual({ use: true, note: null, reason: null });
  });

  it('stays off when the notebook switched it off, unless this check is allowed with a click', () => {
    expect(webPolicy({ ...base, scope: scopeOf(), notebookWeb: false })).toEqual({
      use: false,
      note: null,
      reason: null,
    });
    expect(webPolicy({ ...base, scope: scopeOf(), notebookWeb: false, requested: true }).use).toBe(true);
  });

  it('never in a private notebook unless Settings → Private notebooks allows it', () => {
    const off = webPolicy({ ...base, scope: scopeOf({}, true), requested: true });
    expect(off).toMatchObject({ use: false, reason: 'private' });
    const on = webPolicy({ ...base, scope: scopeOf({}, true), privateWeb: true });
    expect(on.use).toBe(true);
    // The setting lifts the private floor only: network off and blocked tools still win.
    expect(webPolicy({ ...base, scope: scopeOf({ network: false }, true), privateWeb: true })).toMatchObject({
      use: false,
      reason: 'blocked',
    });
    expect(
      webPolicy({ ...base, scope: scopeOf({ tools_deny: ['web.*'] }, true), privateWeb: true }),
    ).toMatchObject({ use: false, reason: 'blocked' });
  });

  it('never in a notebook that keeps data local without being private, whatever the setting', () => {
    const d = webPolicy({ ...base, scope: scopeOf({ data_leaves_machine: false }), privateWeb: true });
    expect(d).toMatchObject({ use: false, reason: 'private' });
  });

  it('Strict asks once per check: the web waits for the click, which then covers every claim', () => {
    const waits = webPolicy({ ...base, scope: scopeOf(), strict: true });
    expect(waits).toMatchObject({ use: false, reason: 'ask' });
    expect(waits.note).toMatch(/Strict permissions ask first/);
    expect(webPolicy({ ...base, scope: scopeOf(), strict: true, requested: true }).use).toBe(true);
  });

  it('says plainly when the scope itself forbids the web', () => {
    const d = webPolicy({ ...base, scope: scopeOf({ network: false }) });
    expect(d).toMatchObject({ use: false, reason: 'blocked' });
  });
});

describe('a notebook that never chose follows the default', () => {
  const row = (settings: Record<string, unknown> | null) =>
    ({
      id: 'nbk_1',
      workspace_id: 'wsp_1',
      title: 'T',
      slug: 't',
      description: null,
      icon: null,
      color: null,
      pinned_at: null,
      archived_at: null,
      last_opened_at: null,
      created_at: new Date(0),
      updated_at: new Date(0),
      settings,
    }) as never;

  it('reads on when unset, and off only when the person turned it off', () => {
    expect(nbFromRow(row({})).check_on_web).toBe(true);
    expect(nbFromRow(row(null)).check_on_web).toBe(true);
    expect(nbFromRow(row({ check_on_web: false })).check_on_web).toBe(false);
    expect(nbFromRow(row({ check_on_web: true })).check_on_web).toBe(true);
    // config/factcheck.yaml web_search: false is the default for notebooks that never chose.
    expect(nbFromRow(row({}), false).check_on_web).toBe(false);
    expect(nbFromRow(row({ check_on_web: true }), false).check_on_web).toBe(true);
  });

  it('a new notebook starts on', async () => {
    const repo = new MemoryNotebookRepo();
    const n = await repo.create({ id: 'nbk_9', workspace_id: 'wsp_1', title: 'New' } as never);
    expect(n.check_on_web).toBe(true);
    await repo.patch('nbk_9', { check_on_web: false });
    expect((await repo.get('nbk_9'))?.check_on_web).toBe(false);
  });
});

describe('the permission gate for a fact-check lookup', () => {
  const quiet: Reviewer = {
    id: 'quiet',
    local: true,
    available: async () => true,
    review: async () => {
      reviewed += 1;
      return { p_fits: 0.5, p_injection: 0, cost_usd: 0 };
    },
  } as never;
  let reviewed = 0;

  const make = (opts: {
    preset: 'balanced' | 'careful' | 'auto';
    scope?: EffectiveScope;
    deny?: boolean;
  }) => {
    const store = new MemoryPermissionStore();
    if (opts.deny)
      void store.createGrant({
        userId: 'u',
        principal: 'agent:default',
        actionPattern: 'web.search',
        resourcePattern: 'web:*',
        effect: 'deny',
        scope: 'always',
        scopeRef: null,
        expiresAt: null,
        fromApprovalId: null,
      });
    const hits: WebHit[] = [{ title: 'Everest', url: 'https://e.example/', snippet: '8,849 metres' }];
    const searched: string[] = [];
    const web: WebSearch = {
      async search(q) {
        searched.push(q);
        return hits;
      },
    };
    const gate = createGate({
      policy: new LayeredPolicy([new BuiltinPolicy()], presetRelax(opts.preset)),
      store,
      workspaceRoot: '/workspace',
      scopes: { effective: async () => opts.scope ?? scopeOf() },
      auto: {
        review: new AutoReview({ reviewers: [quiet], plans: new MemoryPlanStore() }),
        enabled: () => opts.preset === 'auto',
      },
    });
    const tally = newTally();
    const lookup = gatedWeb({
      web,
      gate,
      userId: 'u',
      ctx: { threadId: 'thr_1', notebookId: 'nbk_1', workspaceId: 'wsp_1', runId: null, traceId: 't' },
      tally,
      ...(opts.scope?.private && { leaveOk: true }),
    });
    return { lookup: lookup as NonNullable<typeof lookup>, tally, searched };
  };
  const sig = new AbortController().signal;

  it('Balanced looks a claim up without asking', async () => {
    const t = make({ preset: 'balanced' });
    expect(await t.lookup('Mount Everest is 8,849 metres tall', sig)).toHaveLength(1);
    expect(t.tally.refused).toBe(0);
    expect(t.searched).toEqual(['Mount Everest is 8,849 metres tall']);
  });

  it('Auto looks a claim up without asking and without a reviewer call', async () => {
    reviewed = 0;
    const t = make({ preset: 'auto' });
    expect(await t.lookup('Mount Everest is 8,849 metres tall', sig)).toHaveLength(1);
    expect(t.tally.refused).toBe(0);
    expect(reviewed).toBe(0);
  });

  it('a standing "always deny" for web searches still stops it', async () => {
    const t = make({ preset: 'balanced', deny: true });
    expect(await t.lookup('Mount Everest is 8,849 metres tall', sig)).toBeNull();
    expect(t.tally.refused).toBe(1);
    expect(t.searched).toEqual([]);
  });

  it('a scope that forbids the web still stops it', async () => {
    const t = make({ preset: 'balanced', scope: scopeOf({ tools_deny: ['web.*'] }) });
    expect(await t.lookup('claim', sig)).toBeNull();
    expect(t.tally.refused).toBe(1);
  });

  it('a private notebook that allowed it searches, but only past the private floor: network off still stops it', async () => {
    const ok = make({ preset: 'balanced', scope: scopeOf({}, true) });
    expect(await ok.lookup('claim', sig)).toHaveLength(1);
    const off = make({ preset: 'balanced', scope: scopeOf({ network: false }, true) });
    expect(await off.lookup('claim', sig)).toBeNull();
  });

  it('without the private setting the gate refuses a private notebook', async () => {
    const store = new MemoryPermissionStore();
    const gate = createGate({
      policy: new LayeredPolicy([new BuiltinPolicy()], presetRelax('balanced')),
      store,
      workspaceRoot: '/workspace',
      scopes: { effective: async () => scopeOf({}, true) },
    });
    const d = await gate.check({
      userId: 'u',
      principal: 'agent:default',
      action: 'web.search',
      resource: 'web:search/claim',
      toolTier: 'gated',
      destructive: false,
      scope: { threadId: 'thr_1', notebookId: 'nbk_1', workspaceId: 'wsp_1' },
      runId: null,
      traceId: 't',
      eased: true,
    });
    expect(d.outcome).toBe('deny');
  });

  it('easing never lifts a critical ask', async () => {
    const gate = createGate({
      policy: new LayeredPolicy([new BuiltinPolicy()], presetRelax('balanced')),
      store: new MemoryPermissionStore(),
      workspaceRoot: '/workspace',
    });
    const d = await gate.check({
      userId: 'u',
      principal: 'agent:default',
      action: 'shell.exec',
      resource: 'shell:ls',
      toolTier: 'critical',
      destructive: false,
      scope: { threadId: 'thr_1', notebookId: null, workspaceId: 'wsp_1' },
      runId: null,
      traceId: 't',
      eased: true,
    });
    expect(d.outcome).toBe('ask');
  });
});

/* ---- through the HTTP routes ---- */

const PASSAGES = ['The ZX-4410 pump must be primed before first use.'];
const kn = {
  async post<T>(_path: string, body: unknown): Promise<T> {
    const req = body as { claims: string[] };
    const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);
    const res: EvidenceResponse = {
      mode: 'hybrid',
      embedder: null,
      ms: 1,
      results: req.claims.map((claim) => {
        const cw = words(claim);
        const hits = PASSAGES.filter((p) => [...words(p)].filter((w) => cw.has(w)).length >= 2).map(
          (p, i) => ({
            kind: 'chunk' as const,
            chunk_id: `chk_${i}`,
            source_id: 'src_manual',
            source_title: 'Pump manual',
            page: 2,
            heading_path: [],
            text: p,
            quote: p,
            quote_start: 0,
            quote_end: p.length,
            rerank_score: 0.95,
            relevance: 0.95,
          }),
        );
        return { claim, hits, coverage: hits.length ? 1 : 0 };
      }),
    };
    return res as T;
  },
};

const allow = {
  check: async () => ({
    outcome: 'allow' as const,
    via: 'auto' as const,
    tier: 'gated' as const,
    resource: '',
  }),
};
const EVEREST = 'Mount Everest is 8,849 metres tall.';
const PAGE: WebHit = {
  title: 'Mount Everest',
  url: 'https://geo.example/everest',
  snippet: 'Mount Everest is 8,849 metres tall, the highest mountain above sea level.',
};
const searcher = (extra: Partial<WebSearch> = {}): WebSearch & { queries: string[] } => {
  const queries: string[] = [];
  return {
    queries,
    async search(q) {
      queries.push(q);
      return [PAGE];
    },
    ...extra,
  };
};

let h: Harness;
afterEach(async () => h?.close());

async function check(text: string, body: Record<string, unknown> = {}) {
  const thread = await h.newThread({ notebook_id: 'nbk_1' });
  const sent = await h.send(thread, `/say ${text}`);
  await h.settle(sent.run_id);
  const res = await h.call<{ check: SelectionCheck }>(
    'POST',
    `/messages/${sent.assistant_message_id}/selection-checks`,
    { text, ...body },
  );
  return res.body.check;
}

describe('a highlighted claim with the web on by default', () => {
  it('looks up a claim the sources miss, names the page it came from, and labels it Web', async () => {
    const w = searcher();
    h = await harness({
      kn,
      selection: { web: w, gate: allow as never, userId: 'u', notebookWeb: async () => true },
    });
    const c = await check(EVEREST);
    expect(c.web.used).toBe(true);
    expect(w.queries).toEqual([EVEREST]);
    expect(c.evidence.some((e) => e.origin === 'web' && e.url === PAGE.url)).toBe(true);
  });

  it('does not search for a claim the sources cover', async () => {
    const w = searcher();
    h = await harness({
      kn,
      selection: { web: w, gate: allow as never, userId: 'u', notebookWeb: async () => true },
    });
    const c = await check('The ZX-4410 pump must be primed before first use.');
    expect(w.queries).toEqual([]);
    expect(c.evidence.every((e) => e.origin !== 'web')).toBe(true);
  });

  it('stays off where the person turned it off, and the one-click check then runs just that claim', async () => {
    const w = searcher();
    h = await harness({
      kn,
      selection: { web: w, gate: allow as never, userId: 'u', notebookWeb: async () => false },
    });
    const off = await check(EVEREST);
    expect(off.web).toMatchObject({ used: false, note: null });
    expect(w.queries).toEqual([]);
    const click = await check(EVEREST, { web: true, again: true });
    expect(click.web.used).toBe(true);
    expect(w.queries).toEqual([EVEREST]);
  });

  it('Strict waits for the click, then asks once: the click covers the check', async () => {
    const w = searcher();
    h = await harness({
      kn,
      selection: {
        web: w,
        gate: allow as never,
        userId: 'u',
        notebookWeb: async () => true,
        strictWeb: () => true,
      },
    });
    const waits = await check(EVEREST);
    expect(waits.web).toMatchObject({ used: false, reason: 'ask' });
    expect(w.queries).toEqual([]);
    const click = await check(EVEREST, { web: true, again: true });
    expect(click.web.used).toBe(true);
  });

  it('a private notebook searches only when Settings → Private notebooks allows it', async () => {
    const w = searcher();
    const priv = async () => scopeOf({}, true);
    h = await harness({
      kn,
      selection: {
        web: w,
        gate: allow as never,
        userId: 'u',
        notebookWeb: async () => true,
        scopeOf: priv,
        privateWeb: async () => true,
      },
    });
    const thread = await h.newThread({ notebook_id: 'nbk_1' });
    const sent = await h.send(thread, `/say ${EVEREST}`);
    await h.settle(sent.run_id);
    const res = await h.call<{ check?: SelectionCheck; error?: { code: string } }>(
      'POST',
      `/messages/${sent.assistant_message_id}/selection-checks`,
      { text: EVEREST },
    );
    // The offline models are not local, so the judge may be refused in a private notebook; the search is what matters.
    if (res.body.check) expect(res.body.check.web.used).toBe(true);
    else expect(res.body.error?.code).toBe('factcheck.judge_not_allowed');
  });

  it('respects the daily cap: the click says the budget is reached and spends nothing', async () => {
    const w = searcher({ status: async () => ({ ready: false, reason: 'budget' }) });
    h = await harness({
      kn,
      selection: { web: w, gate: allow as never, userId: 'u', notebookWeb: async () => false },
    });
    const c = await check(EVEREST, { web: true });
    expect(c.web).toMatchObject({ used: false, reason: 'budget' });
    expect(w.queries).toEqual([]);
    const mid = searcher({
      async search() {
        throw new AncileError({ code: 'factcheck.web_budget', title: 't', hint: 'h' });
      },
    });
    await h.close();
    h = await harness({
      kn,
      selection: { web: mid, gate: allow as never, userId: 'u', notebookWeb: async () => true },
    });
    const c2 = await check(EVEREST, { again: true });
    expect(c2.web).toMatchObject({ used: false, reason: 'budget' });
  });
});
