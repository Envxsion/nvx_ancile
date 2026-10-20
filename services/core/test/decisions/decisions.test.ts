/**
 * Decision models (docs/decisions.md): each adapter's request and answer shape, free allowance
 * counting and the margin, the UTC reset, 402 moving to the next route, private notebooks and the
 * local server, no decision model at all, receipts without cache claims, and the callers
 * (Auto review, flow routes, fact-check triage). No real service is called: every fetch is fake.
 */
import type { DecisionRequest } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { callRoute, parseAnswer, urlFor } from '../../src/decisions/adapters';
import { decideRoute, decisionTriage } from '../../src/decisions/ask';
import { ALLOWANCES, CLOUDFLARE_ALLOWANCE, routeDef, SECRETS } from '../../src/decisions/catalogue';
import { DecisionRouter } from '../../src/decisions/router';
import { Allowances, Counters } from '../../src/free/allowances';
import { DecisionReviewer } from '../../src/permissions/auto/decision-reviewer';
import type { ReviewInput } from '../../src/permissions/auto/reviewers';
import { PrivacyPolicies } from '../../src/privacy/policy';
import { MemorySettings } from '../../src/settings';

interface Hit {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

type Handler = (hit: Hit) => { status?: number; json: unknown };

function fakeFetch(handler: Handler, hits: Hit[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    if (String(url).endsWith('/v1/models')) return new Response('{}', { status: 200 });
    const hit: Hit = {
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    };
    hits.push(hit);
    const out = handler(hit);
    return new Response(JSON.stringify(out.json), { status: out.status ?? 200 });
  }) as unknown as typeof fetch;
}

const noul = (p: number) => ({ type: 'noul', noul: p });
const usage = (input: number, cost?: number) => ({
  input_tokens: input,
  output_tokens: 3,
  ...(cost !== undefined && { cost }),
});

const ask: DecisionRequest = {
  state: 'We were billed twice.',
  questions: { billing: { type: 'noul', instructions: 'Is this about billing?' } },
};

const KEYS: Record<string, string> = {
  [SECRETS.openrouter]: 'or-key-1234567890',
  [SECRETS.typesafe]: 'ts-key-1234567890',
  [SECRETS.cloudflareToken]: 'cf-token-1234567890',
  [SECRETS.cloudflareAccount]: 'a'.repeat(32),
  [SECRETS.perplexity]: 'pplx-key-1234567890',
};

function make(opts: {
  keys?: Record<string, string>;
  handler: Handler;
  priv?: string[];
  policyOn?: boolean;
  local?: string;
  now?: { t: number };
  disabled?: string[];
}) {
  const hits: Hit[] = [];
  const settings = new MemorySettings();
  const clock = opts.now ?? { t: Date.parse('2026-10-20T01:00:00Z') };
  const now = () => clock.t;
  const counters = new Counters(settings, now);
  const allowances = new Allowances(counters, ALLOWANCES, now);
  const keys = opts.keys ?? KEYS;
  const router: DecisionRouter = new DecisionRouter({
    settings,
    counters,
    allowances,
    secrets: { get: async (n) => keys[n] },
    privacy: new PrivacyPolicies({
      settings,
      isPrivate: async (id) => (opts.priv ?? ['nb_priv']).includes(id),
      localAvailable: () => router.localAvailable(),
    }),
    fetch: fakeFetch(opts.handler, hits),
    now,
  });
  const ready = (async () => {
    if (opts.policyOn)
      await new PrivacyPolicies({ settings }).update({ decisions_off_machine: { allowed_in_private: true } });
    await router.update({
      ...(opts.local && { local: { url: opts.local, model: 'Cloudflare/clef-flash' } }),
      ...(opts.disabled && { disabled: opts.disabled as never }),
    });
  })();
  return { router, hits, counters, allowances, clock, ready };
}

const cfOk: Handler = (h) => ({
  json: {
    success: true,
    result: { answers: { billing: noul(0.9) }, usage: usage(100) },
    model: h.body.model,
  },
});

describe('adapters', () => {
  it('Jev on OpenRouter: bearer key, model in the body, answers under answers', async () => {
    const hits: Hit[] = [];
    const out = await callRoute({
      def: routeDef('jev_openrouter'),
      model: '~typesafe/jev-latest',
      key: 'or-key',
      request: ask,
      timeoutMs: 1000,
      fetch: fakeFetch(
        () => ({ json: { answers: { billing: noul(0.97) }, usage: usage(120, 0.000005) } }),
        hits,
      ),
    });
    expect(hits[0]?.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(hits[0]?.headers.authorization).toBe('Bearer or-key');
    expect(hits[0]?.body).toMatchObject({
      model: '~typesafe/jev-latest',
      state: ask.state,
      questions: ask.questions,
    });
    expect(out.answers.billing).toEqual({ type: 'noul', noul: 0.97 });
    expect(out).toMatchObject({ input_tokens: 120, output_tokens: 3, cost_usd: 0.000005 });
  });

  it('Jev direct goes to TypeSafe systemone', () => {
    expect(urlFor(routeDef('jev_direct'), 'jev-latest')).toBe('https://api.typesafe.ai/v1/systemone');
  });

  it('Cloudflare: account URL, unwraps result, reads choice and score answers', async () => {
    const hits: Hit[] = [];
    const request: DecisionRequest = {
      state: 'x',
      questions: {
        tone: { type: 'choice', instructions: 't', criteria: { calm: 'c', angry: 'a' } },
        urgency: { type: 'score', instructions: 'u', criteria: ['Can wait', 'Today'] },
      },
    };
    const out = await callRoute({
      def: routeDef('cf_clef_flash'),
      model: 'clef-flash',
      key: 'tok',
      accountId: 'b'.repeat(32),
      request,
      timeoutMs: 1000,
      fetch: fakeFetch(
        () => ({
          json: {
            success: true,
            result: {
              answers: {
                tone: {
                  type: 'choice',
                  choice: 'calm',
                  confidence: 0.7,
                  probabilities: { calm: 0.8, angry: 0.2 },
                },
                urgency: {
                  type: 'score',
                  score: 0.4,
                  confidence: 0.5,
                  probabilities: { '0': 0.6, '1': 0.4 },
                },
              },
              usage: { input_tokens: 50, output_tokens: 2 },
            },
          },
        }),
        hits,
      ),
    });
    expect(hits[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${'b'.repeat(32)}/ai/run/@cf/cloudflare/clef-flash`,
    );
    expect(hits[0]?.body.model).toBe('clef-flash');
    expect(out.answers.tone).toMatchObject({ type: 'choice', choice: 'calm' });
    expect(out.answers.urgency).toMatchObject({ type: 'score', score: 0.4 });
    expect(out.input_tokens).toBe(50);
  });

  it('Perplexity: its own endpoint and model alias', async () => {
    const hits: Hit[] = [];
    await callRoute({
      def: routeDef('pplx_decider'),
      model: 'pplx-decider-latest',
      key: 'k',
      request: ask,
      timeoutMs: 1000,
      fetch: fakeFetch(
        () => ({ json: { answers: { billing: { type: 'noul', noul: 0.94 } }, usage: usage(367) } }),
        hits,
      ),
    });
    expect(hits[0]?.url).toBe('https://api.perplexity.ai/v1/decisions');
    expect(hits[0]?.body.model).toBe('pplx-decider-latest');
  });

  it('a local server needs no key and speaks /v1/systemone', async () => {
    const hits: Hit[] = [];
    await callRoute({
      def: routeDef('local_jev'),
      model: 'Cloudflare/clef-flash',
      key: undefined,
      localUrl: 'http://localhost:30000/',
      request: ask,
      timeoutMs: 1000,
      fetch: fakeFetch(() => ({ json: { answers: { billing: noul(0.5) } } }), hits),
    });
    expect(hits[0]?.url).toBe('http://localhost:30000/v1/systemone');
    expect(hits[0]?.headers.authorization).toBeUndefined();
  });

  it('a 402 carries a code the router acts on, with the provider words and never the key', async () => {
    const err = await callRoute({
      def: routeDef('jev_openrouter'),
      model: 'm',
      key: 'SECRETKEY123',
      request: ask,
      timeoutMs: 1000,
      fetch: fakeFetch(() => ({
        status: 402,
        json: { error: { message: 'Insufficient credits SECRETKEY123' } },
      })),
    }).catch((e) => e);
    expect(err.code).toBe('decisions.no_credit');
    expect(err.message).toContain('Insufficient credits');
    expect(err.message).not.toContain('SECRETKEY123');
  });

  it('an answer that does not fit the question is refused', () => {
    expect(parseAnswer(ask.questions.billing as never, { type: 'noul' })).toBeNull();
    expect(parseAnswer(ask.questions.billing as never, 0.3)).toEqual({ type: 'noul', noul: 0.3 });
  });
});

describe('routing', () => {
  it('uses the free Cloudflare allowance first, counts neurons, and the receipt claims no cache saving', async () => {
    const t = make({ handler: cfOk });
    await t.ready;
    const res = await t.router.decide('flow_router', ask);
    expect(res.ok && res.receipt.route).toBe('cf_clef_flash');
    if (!res.ok) return;
    // 100 tokens at 3,455 neurons per million.
    expect(res.receipt.allowance_used).toBeCloseTo(0.3455, 4);
    expect(res.receipt).toMatchObject({
      cost_usd: 0,
      cost_basis: 'free',
      allowance: CLOUDFLARE_ALLOWANCE,
      output_tokens: 3,
    });
    expect(Object.keys(res.receipt).some((k) => /cache/i.test(k))).toBe(false);
    expect(await t.allowances.used(CLOUDFLARE_ALLOWANCE)).toBeCloseTo(0.3455, 4);
  });

  it('a reasoning task prefers Clef (free) over Clef-flash, and a fast one the reverse', async () => {
    const t = make({ handler: cfOk });
    await t.ready;
    const a = await t.router.decide('auto_review', ask);
    const b = await t.router.decide('flow_router', ask);
    expect(a.ok && a.receipt.route).toBe('cf_clef');
    expect(b.ok && b.receipt.route).toBe('cf_clef_flash');
  });

  it('never goes past the ceiling: at the margin it leaves for the cheapest connected route', async () => {
    const t = make({
      handler: (h) =>
        String(h.url).includes('cloudflare.com')
          ? cfOk(h)
          : { json: { answers: { billing: noul(0.8) }, usage: usage(100, 0.0000042) } },
    });
    await t.ready;
    // 9,940 neurons used; a 12,000-character request is about 3,000 tokens, over 10 neurons on Clef-flash.
    await t.allowances.record(CLOUDFLARE_ALLOWANCE, 9_940);
    const big: DecisionRequest = { ...ask, state: 'x'.repeat(12_000) };
    const res = await t.router.decide('flow_router', big);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt.provider).not.toBe('cloudflare');
    expect(res.receipt.cost_basis).toBe('reported');
    expect(await t.allowances.used(CLOUDFLARE_ALLOWANCE)).toBe(9_940);
    expect(res.tried.some((x) => x.route === 'cf_clef_flash')).toBe(true);
  });

  it('with free first off, the cheapest suitable route is used', async () => {
    const t = make({
      handler: (h) => ({ json: { answers: { billing: noul(0.8) }, usage: usage(10), model: h.body.model } }),
    });
    await t.ready;
    await t.router.update({ free_first: false });
    const res = await t.router.decide('flow_router', ask);
    // Perplexity flash ($0.01/M) undercuts Clef-flash ($0.038/M) when free is not preferred.
    expect(res.ok && res.receipt.route).toBe('pplx_flash');
  });

  it('resets at 00:00 UTC', async () => {
    const t = make({ handler: cfOk });
    await t.ready;
    await t.allowances.record(CLOUDFLARE_ALLOWANCE, 9_990);
    expect(await t.allowances.canSpend(CLOUDFLARE_ALLOWANCE, 1)).toBe(false);
    t.clock.t = Date.parse('2026-10-21T00:00:01Z');
    expect(await t.allowances.used(CLOUDFLARE_ALLOWANCE)).toBe(0);
    expect(await t.allowances.canSpend(CLOUDFLARE_ALLOWANCE, 1)).toBe(true);
    const meters = await t.allowances.meters();
    expect(meters[0]?.resets_at).toBe('2026-10-22T00:00:00.000Z');
  });

  it('a 402 moves from Jev on OpenRouter to Jev on TypeSafe and the dead route rests', async () => {
    const t = make({
      keys: { [SECRETS.openrouter]: 'or-key-1234567890', [SECRETS.typesafe]: 'ts-key-1234567890' },
      handler: (h) =>
        h.url.includes('openrouter')
          ? { status: 402, json: { error: { message: 'Insufficient credits' } } }
          : { json: { answers: { billing: noul(0.7) }, usage: usage(100) } },
    });
    await t.ready;
    const res = await t.router.decide('auto_review', ask);
    expect(res.ok && res.receipt.route).toBe('jev_direct');
    if (res.ok) expect(res.tried[0]).toMatchObject({ route: 'jev_openrouter' });
    // Rested: the next decision does not even try OpenRouter.
    t.hits.length = 0;
    await t.router.decide('auto_review', ask);
    expect(t.hits.every((h) => !h.url.includes('openrouter'))).toBe(true);
  });

  it('Cloudflare saying the allowance is gone stops further tries until the reset', async () => {
    const t = make({
      keys: { [SECRETS.cloudflareToken]: 'cf-token-1234567890', [SECRETS.cloudflareAccount]: 'a'.repeat(32) },
      handler: () => ({
        status: 429,
        json: {
          success: false,
          errors: [{ code: 4006, message: 'daily free allocation of 10,000 neurons exceeded' }],
        },
      }),
    });
    await t.ready;
    const res = await t.router.decide('flow_router', ask);
    expect(res.ok).toBe(false);
    expect(await t.allowances.canSpend(CLOUDFLARE_ALLOWANCE, 0.01)).toBe(false);
  });

  it('holds paid routes to the daily cap', async () => {
    const t = make({
      keys: { [SECRETS.typesafe]: 'ts-key-1234567890' },
      handler: () => ({ json: { answers: { billing: noul(0.7) }, usage: usage(1_000_000, 0.042) } }),
    });
    await t.ready;
    await t.router.update({ caps: [{ scope: 'route', key: 'jev_direct', usd_per_day: 0.05 }] });
    expect((await t.router.decide('auto_review', ask)).ok).toBe(true);
    const second = await t.router.decide('auto_review', ask);
    // 0.042 spent; the next estimate would still fit 0.05, so a third is the one that is refused.
    expect(second.ok).toBe(true);
    const third = await t.router.decide('auto_review', ask);
    expect(third.ok).toBe(false);
  });

  it('with no decision model, the caller gets a quiet note and nothing throws', async () => {
    const t = make({ keys: {}, handler: cfOk });
    await t.ready;
    const res = await t.router.decide('flow_router', ask);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.note).toMatch(/usual way/);
  });

  it('the OpenAI preview stays off until switched on, and says why when it refuses', async () => {
    const t = make({
      keys: { [SECRETS.openai]: 'sk-test-1234567890' },
      handler: () => ({
        status: 403,
        json: { error: { message: 'Decision API is not enabled for this user' } },
      }),
    });
    await t.ready;
    expect((await t.router.decide('flow_router', ask)).ok).toBe(false);
    expect(t.hits.length).toBe(0);
    await t.router.update({ disabled: [] });
    const res = await t.router.decide('flow_router', ask);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.tried[0]?.reason).toMatch(/not enabled/i);
    const status = await t.router.status();
    expect(status.routes.find((r) => r.id === 'openai_luna')).toMatchObject({
      state: 'refused',
      verified: false,
    });
  });
});

describe('private notebooks', () => {
  const hosted: Handler = (h) => ({
    json: { answers: { billing: noul(0.9) }, usage: usage(10), model: h.body.model },
  });

  it('use no hosted route unless allowed', async () => {
    const t = make({ handler: hosted });
    await t.ready;
    const res = await t.router.decide('flow_router', ask, { notebookId: 'nb_priv' });
    expect(res.ok).toBe(false);
    expect(t.hits.length).toBe(0);
    if (!res.ok) expect(res.note).toMatch(/Private notebooks/);
  });

  it('use the local server first, even when hosted is allowed', async () => {
    const t = make({ handler: hosted, local: 'http://localhost:30000', policyOn: true });
    await t.ready;
    const res = await t.router.decide('flow_router', ask, { notebookId: 'nb_priv' });
    expect(res.ok && res.receipt).toMatchObject({ route: 'local_jev', provider: 'local', cost_usd: 0 });
    expect(t.hits.every((h) => h.url.startsWith('http://localhost'))).toBe(true);
  });

  it('use the local server alone when hosted is off', async () => {
    const t = make({ handler: hosted, local: 'http://localhost:30000' });
    await t.ready;
    const res = await t.router.decide('auto_review', ask, { notebookId: 'nb_priv' });
    expect(res.ok && res.receipt.route).toBe('local_jev');
  });

  it('use hosted routes when allowed and no local server is set', async () => {
    const t = make({ handler: hosted, policyOn: true });
    await t.ready;
    const res = await t.router.decide('flow_router', ask, { notebookId: 'nb_priv' });
    expect(res.ok && res.receipt.provider).toBe('cloudflare');
  });

  it('a notebook that is not private may use hosted routes', async () => {
    const t = make({ handler: hosted });
    await t.ready;
    expect((await t.router.decide('flow_router', ask, { notebookId: 'nb_open' })).ok).toBe(true);
  });
});

describe('callers', () => {
  const review: ReviewInput = {
    call: { action: 'shell.exec', resource: 'shell:ls', outsideRoot: false } as never,
    plan: null,
    scope: null,
    project: { root: '/w' },
  };

  it('the Auto reviewer asks two noul questions and returns two probabilities', async () => {
    const t = make({
      handler: (h) => ({
        json: {
          answers: { fits: noul(0.93), injection: noul(0.02) },
          usage: usage(400),
          model: h.body.model,
        },
      }),
    });
    await t.ready;
    const r = new DecisionReviewer(t.router, 'hosted');
    expect(await r.available()).toBe(true);
    const a = await r.review(review);
    expect(a).toMatchObject({ p_fits: 0.93, p_injection: 0.02, cost_usd: 0 });
    expect(Object.keys(t.hits[0]?.body.questions as object)).toEqual(['fits', 'injection']);
  });

  it('the hosted reviewer is unavailable with no key, and the local one without a server', async () => {
    const t = make({ keys: {}, handler: cfOk });
    await t.ready;
    expect(await new DecisionReviewer(t.router, 'hosted').available()).toBe(false);
    expect(await new DecisionReviewer(t.router, 'local').available()).toBe(false);
    await expect(new DecisionReviewer(t.router, 'hosted').review(review)).rejects.toThrow();
  });

  it('decideRoute asks one choice question and reads the best label', async () => {
    const t = make({
      handler: () => ({
        json: {
          answers: {
            route: {
              type: 'choice',
              choice: 'code',
              confidence: 0.8,
              probabilities: { code: 0.8, writing: 0.2 },
            },
          },
          usage: usage(80),
        },
      }),
    });
    await t.ready;
    const out = await decideRoute(t.router, {
      text: 'Fix this bug',
      routes: [{ label: 'code', when: 'programming' }, { label: 'writing' }],
    });
    expect(out).toMatchObject({ chose: ['code'], confidence: 0.8 });
    expect(t.hits[0]?.body.questions).toMatchObject({
      route: { type: 'choice', criteria: { code: 'programming', writing: 'writing' } },
    });
  });

  it('decideRoute gives null when no decision model answers (the chat model decides)', async () => {
    const t = make({ keys: {}, handler: cfOk });
    await t.ready;
    expect(await decideRoute(t.router, { text: 'hi', routes: [{ label: 'a' }] })).toBeNull();
  });

  it('decisionTriage returns a tier per claim and the careful tier for a miss', async () => {
    const t = make({
      handler: (h) => ({
        json: {
          answers: {
            c0: { type: 'choice', choice: 'none', confidence: 0.9, probabilities: { none: 0.9 } },
            c1: { type: 'choice', choice: 'deep', confidence: 0.6, probabilities: { deep: 0.6 } },
          },
          usage: usage(200),
          model: h.body.model,
        },
      }),
    });
    await t.ready;
    const tiers = await decisionTriage(t.router).classify([
      'I think tea is nice',
      'The 2026 GDP of X was 3.1%',
    ]);
    expect(tiers).toEqual(['none', 'deep']);
    const off = make({ keys: {}, handler: cfOk });
    await off.ready;
    expect(await decisionTriage(off.router).classify(['a', 'b'])).toEqual(['deep', 'deep']);
  });
});

describe('settings and status', () => {
  it('lists every route with its state and the allowance meter, without any key', async () => {
    const t = make({ handler: cfOk });
    await t.ready;
    const s = await t.router.status();
    expect(s.routes.find((r) => r.id === 'cf_clef_flash')?.state).toBe('ready');
    expect(s.routes.find((r) => r.id === 'local_jev')?.state).toBe('not_connected');
    expect(s.meters[0]).toMatchObject({ id: CLOUDFLARE_ALLOWANCE, limit: 10_000, ceiling: 9_950, used: 0 });
    expect(JSON.stringify(s)).not.toContain('cf-token');
  });

  it('refuses a local address that is not http', async () => {
    const t = make({ handler: cfOk });
    await t.ready;
    await expect(t.router.update({ local: { url: 'ftp://x', model: 'm' } })).rejects.toMatchObject({
      code: 'decisions.local_url_invalid',
    });
  });
});
