/**
 * Web evidence from a live re-test (21 Oct): a lookup has to bring back text from the page (never a bare
 * title and link), the route that ran and its cost are kept, a route that fails is rested with its reason,
 * and the order is sources, then common knowledge for an obvious claim, then the web. Fakes only.
 */
import type { ModelConfig, ModelTier } from '@nvx/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  type CheckDeps,
  type Checked,
  checkClaim,
  checkWebLast,
  declarativeSentences,
  extractClaims,
  type Gathered,
  gatherEvidence,
  lookupWebEvidence,
  type StepDeps,
} from '../../src/factcheck/steps';
import { triageClaim } from '../../src/factcheck/triage';
import { gatedWeb, newTally, type WebHit, type WebSearch } from '../../src/factcheck/web';
import { parseHitList, WEB_SPEND_SETTING, webSearchChain, withText } from '../../src/factcheck/web-models';
import type { Gateway } from '../../src/gateway/gateway';
import { resolveWant } from '../../src/gateway/tiers';
import { MemorySettings } from '../../src/settings';
import { fakeModel } from '../gateway/fake-provider';

const sig = () => new AbortController().signal;

/* ---- The routes --------------------------------------------------------------- */

const model = (provider: string, id: string, secret: string): ModelConfig => ({
  ...fakeModel(id, 'script'),
  id: `${provider}/${id}`,
  provider,
  provider_model: id,
  price: { input_per_mtok: 0.3, output_per_mtok: 2.5 },
  secret,
});
const GEMINI = model('google', 'gemini-3.5-flash-lite', 'GOOGLE_GENERATIVE_AI_API_KEY');
const HAIKU = model('anthropic', 'claude-haiku-5-5', 'ANTHROPIC_API_KEY');
const ROUTER = model('openrouter', 'anthropic/claude-haiku-5.5', 'OPENROUTER_API_KEY');

const reply = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const KEYS = { GOOGLE_GENERATIVE_AI_API_KEY: 'g', OPENROUTER_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' };

function chain(
  models: ModelConfig[],
  answers: Partial<Record<'google' | 'openrouter' | 'anthropic', () => Promise<Response>>>,
  at = { now: new Date(2026, 9, 21, 12) },
) {
  const hosts: string[] = [];
  const fetcher = vi.fn(async (input: string | URL) => {
    const host = new URL(String(input)).hostname;
    hosts.push(host);
    const key = host.startsWith('generativelanguage')
      ? 'google'
      : host.startsWith('openrouter')
        ? 'openrouter'
        : 'anthropic';
    return (await answers[key]?.()) ?? new Response('{}', { status: 500 });
  }) as unknown as typeof fetch;
  const web = webSearchChain({
    models: () => models,
    secret: async (n) => (KEYS as Record<string, string>)[n],
    settings: new MemorySettings(),
    capUsd: () => 0.25,
    fetch: fetcher,
    now: () => at.now,
  });
  return { web, hosts, at };
}

describe('web hits carry text from the page', () => {
  it('drops a page the model listed without a snippet instead of passing it on empty', () => {
    const list = JSON.stringify([
      { title: 'Britannica', url: 'https://www.britannica.com/place/Mount-Everest', snippet: '' },
      { title: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Mount_Everest' },
      {
        title: 'Survey',
        url: 'https://survey.example/everest',
        snippet: 'The official height is 8,848.86 m.',
      },
    ]);
    expect(parseHitList(list)).toEqual([
      {
        title: 'Survey',
        url: 'https://survey.example/everest',
        snippet: 'The official height is 8,848.86 m.',
      },
    ]);
  });

  it('fills a bare page from the passage the provider cited for it, by link or by site', () => {
    const hits = [
      { title: 'A', url: 'https://a.example/x', snippet: '' },
      { title: 'B', url: 'https://www.b.example/y', snippet: '' },
      { title: 'C', url: 'https://c.example/z', snippet: '' },
    ];
    const cited = new Map([
      ['https://a.example/x', 'A says so.'],
      ['site:b.example', 'B says so.'],
    ]);
    expect(withText(hits, cited).map((h) => [h.url, h.snippet])).toEqual([
      ['https://a.example/x', 'A says so.'],
      ['https://www.b.example/y', 'B says so.'],
    ]);
  });

  it('Anthropic: uses the cited text of the search results when the list has no snippets', async () => {
    const bare = JSON.stringify([{ title: 'Britannica', url: 'https://www.britannica.com/e', snippet: '' }]);
    const c = chain([HAIKU], {
      anthropic: () =>
        reply({
          content: [
            {
              type: 'text',
              text: bare,
              citations: [
                {
                  url: 'https://www.britannica.com/e',
                  title: 'Britannica',
                  cited_text: 'Mount Everest, 29,032 feet (8,849 metres) high.',
                },
              ],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50, server_tool_use: { web_search_requests: 1 } },
        }),
    });
    const hits = await c.web.search('Mount Everest is 8,849 metres tall.', sig());
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toMatch(/8,849 metres/);
  });

  it('Gemini: uses the grounded sentence Google ties to a site when the list has no snippets', async () => {
    const bare = JSON.stringify([{ title: 'Britannica', url: 'https://www.britannica.com/e' }]);
    const c = chain([GEMINI], {
      google: () =>
        reply({
          candidates: [
            {
              content: { parts: [{ text: bare }] },
              groundingMetadata: {
                groundingChunks: [
                  { web: { uri: 'https://vertexaisearch.example/r/1', title: 'britannica.com' } },
                ],
                groundingSupports: [
                  {
                    segment: { text: 'Everest stands 8,849 metres above sea level.' },
                    groundingChunkIndices: [0],
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30 },
        }),
    });
    const hits = await c.web.search('q', sig());
    expect(hits[0]).toMatchObject({
      url: 'https://www.britannica.com/e',
      snippet: 'Everest stands 8,849 metres above sea level.',
      via: { route: 'google', free: true },
    });
  });

  it('OpenRouter: uses the annotation content when the list has no snippets', async () => {
    const c = chain([ROUTER], {
      openrouter: () =>
        reply({
          choices: [
            {
              message: {
                content: JSON.stringify([{ title: 'T', url: 'https://t.example/a' }]),
                annotations: [
                  {
                    type: 'url_citation',
                    url_citation: { url: 'https://t.example/a', content: 'Exa text.' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
    });
    expect((await c.web.search('q', sig()))[0]?.snippet).toBe('Exa text.');
  });

  it('a route that finds pages but no text hands over to the next, and nothing is passed on empty', async () => {
    const titlesOnly = JSON.stringify([{ title: 'Only a title', url: 'https://x.example/' }]);
    const c = chain([GEMINI, HAIKU], {
      google: () =>
        reply({ candidates: [{ content: { parts: [{ text: titlesOnly }] } }], usageMetadata: {} }),
      anthropic: () =>
        reply({
          content: [
            {
              type: 'text',
              text: JSON.stringify([{ title: 'N', url: 'https://n.example/', snippet: 'Real text.' }]),
            },
          ],
          usage: { server_tool_use: { web_search_requests: 1 } },
        }),
    });
    const hits = await c.web.search('q', sig());
    expect(c.hosts).toEqual(['generativelanguage.googleapis.com', 'api.anthropic.com']);
    expect(hits.map((h) => h.snippet)).toEqual(['Real text.']);

    // Nothing quotable anywhere is an empty answer, not evidence.
    const none = chain([GEMINI], {
      google: () =>
        reply({ candidates: [{ content: { parts: [{ text: titlesOnly }] } }], usageMetadata: {} }),
    });
    expect(await none.web.search('q', sig())).toEqual([]);
  });

  it('the evidence a lookup returns never has an empty quote', async () => {
    const look = vi.fn(async () => [
      { title: 'Empty', url: 'https://e.example/', snippet: '' },
      { title: 'Text', url: 'https://t.example/', snippet: 'Height 8,849 m.' },
    ]);
    const ev = await lookupWebEvidence(look, 'Mount Everest is 8,849 metres tall.', sig());
    expect(ev.map((e) => e.quote)).toEqual(['Height 8,849 m.']);
  });
});

describe('which route ran and what it cost', () => {
  it('marks every hit with its route, label, model and cost, and Gemini inside the allowance as free', async () => {
    const list = JSON.stringify([{ title: 'T', url: 'https://t.example/', snippet: 'Text.' }]);
    const c = chain([GEMINI], {
      google: () =>
        reply({
          candidates: [{ content: { parts: [{ text: list }] } }],
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 },
        }),
    });
    const hits = await c.web.search('q', sig());
    expect(hits[0]?.via).toMatchObject({
      route: 'google',
      label: 'Gemini',
      model_id: 'google/gemini-3.5-flash-lite',
      free: true,
    });
    expect(hits[0]?.via?.cost_usd).toBeGreaterThan(0);
  });

  it('gatedWeb keeps each lookup in the check tally', async () => {
    const via = {
      route: 'anthropic',
      label: 'Claude Haiku',
      model_id: 'm',
      cost_usd: 0.011,
      free: false,
    } as const;
    const web: WebSearch = {
      search: async () => [{ title: 't', url: 'https://x.example/', snippet: 's', via }],
    };
    const gate = {
      check: async () => ({
        outcome: 'allow' as const,
        via: 'grant' as const,
        tier: 'gated' as const,
        resource: '',
      }),
    };
    const tally = newTally();
    const look = gatedWeb({
      web,
      gate: gate as never,
      userId: 'u',
      ctx: { threadId: 't', notebookId: null, workspaceId: 'w', runId: null, traceId: 'tr' },
      tally,
    });
    await look?.('q', sig());
    expect(tally.lookups).toEqual([via]);
  });
});

describe('a route that fails is rested, with its reason', () => {
  const ok = JSON.stringify([{ title: 'N', url: 'https://n.example/', snippet: 'Text.' }]);
  const claude = () =>
    reply({ content: [{ type: 'text', text: ok }], usage: { server_tool_use: { web_search_requests: 1 } } });

  it('does not try Gemini again straight away, says why, and tries it again after the rest', async () => {
    const c = chain([GEMINI, HAIKU], {
      google: () => reply({ error: { message: 'Search grounding is not enabled for this key.' } }, 403),
      anthropic: claude,
    });
    await c.web.search('one', sig());
    await c.web.search('two', sig());
    // Gemini was asked once; the second lookup went straight to Claude.
    expect(c.hosts).toEqual(['generativelanguage.googleapis.com', 'api.anthropic.com', 'api.anthropic.com']);

    const status = await c.web.describe();
    const gem = status.routes.find((r) => r.id === 'google');
    expect(gem).toMatchObject({ state: 'rested', model_id: 'google/gemini-3.5-flash-lite' });
    expect(gem?.reason).toMatch(/403.*Search grounding is not enabled/);
    expect(gem?.rested_until).toBeTruthy();
    expect(status.routes.map((r) => r.id)).toEqual(['google', 'openrouter', 'anthropic']);
    expect(status.routes.find((r) => r.id === 'openrouter')).toMatchObject({ state: 'no_model' });
    expect(status).toMatchObject({ ready: true, via: 'anthropic' });

    // A refused key stays rested for half an hour.
    c.at.now = new Date(2026, 9, 21, 12, 40);
    await c.web.search('three', sig());
    expect(c.hosts.at(-2)).toBe('generativelanguage.googleapis.com');
  });

  it('a route that hung is not retried (the next route gets its turn at once)', async () => {
    let calls = 0;
    const c = chain([GEMINI, HAIKU], {
      google: () => {
        calls += 1;
        return Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
      },
      anthropic: claude,
    });
    await c.web.search('q', sig());
    expect(calls).toBe(1);
  });

  it('says what the chain is when no key is set for a model that is ready', async () => {
    const web = webSearchChain({
      models: () => [GEMINI],
      secret: async () => undefined,
      settings: new MemorySettings(),
      capUsd: () => 0.25,
    });
    const s = await web.describe();
    expect(s.routes.find((r) => r.id === 'google')).toMatchObject({ state: 'no_key' });
    expect(s.ready).toBe(false);
    expect(WEB_SPEND_SETTING).toBe('factcheck.web_spend');
  });
});

/* ---- The order: sources, common knowledge, the web --------------------------- */

const tiers: Record<string, ModelTier> = {};
const llm = (id: string, tier: ModelTier, family: string): ModelConfig => {
  tiers[id] = tier;
  return {
    id,
    provider: family,
    provider_model: id,
    display_name: id,
    via: 'direct',
    family,
    context_window: 100_000,
    max_output: 8_000,
    capabilities: [],
    price: { input_per_mtok: 1, output_per_mtok: 1 },
    enabled: true,
  };
};
const nano = llm('openai/nano', 'tiny', 'openai');
const haiku = llm('anthropic/haiku', 'fast', 'anthropic');
const sonnet = llm('anthropic/sonnet', 'balanced', 'anthropic');

function rig(script: Record<string, { stance: string; confidence?: number }[]>) {
  const ready = [nano, haiku, sonnet];
  const asked: { model: string; prompt: string }[] = [];
  const queue = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const tierOf = (m: ModelConfig) => tiers[m.id] ?? 'fast';
  const registry = {
    resolveWant: (want: never, ctx: object) => resolveWant(want, ready, { ...ctx, tierOf }),
    readyChat: () => ready,
    tierOf,
    get: (id: string) => ready.find((m) => m.id === id),
  };
  const gateway = {
    async *stream(chain: ModelConfig[], req: { messages: { content: unknown }[] }) {
      const m = chain[0] as ModelConfig;
      asked.push({ model: m.id, prompt: JSON.stringify(req.messages) });
      const next = queue[m.id]?.shift() ?? { stance: 'insufficient' };
      yield { type: 'model', modelId: m.id };
      yield {
        type: 'chunk',
        chunk: { type: 'text', delta: JSON.stringify({ evidence: [], rationale: 'r', ...next }) },
      };
    },
  } as unknown as Gateway;
  return { deps: { gateway, registry, promptsDir: '/none' } as unknown as CheckDeps, asked };
}

const held = (over: Partial<Gathered> = {}): Gathered => ({
  evidence: [],
  coverage: 0,
  webDeferred: true,
  ...over,
});
const webHit = (): Gathered['evidence'][number] => ({
  kind: 'url',
  ref: 'https://w.example/',
  source_id: null,
  source_title: 'W',
  page: null,
  char_start: null,
  char_end: null,
  quote: 'Grass is green.',
  stance: 'neutral',
  score: 0.5,
  origin: 'web',
  text: 'W\nGrass is green.',
});

/** What the handler does for one claim, wired the same way. */
function runOrder(
  r: ReturnType<typeof rig>,
  claim: string,
  g: Gathered,
  web: () => Promise<void>,
  extra: Partial<Parameters<typeof checkWebLast>[0]> = {},
) {
  const t = triageClaim(claim, { critical: false });
  return checkWebLast({
    earlier: null,
    g,
    obvious: t.obvious,
    search: web,
    ask: (firstLook) =>
      checkClaim(
        r.deps,
        {
          claim,
          evidence: g.evidence,
          triage: t,
          critical: false,
          generatorFamily: 'anthropic',
          notebookId: 'nb',
          sharing: false,
          ...(firstLook && { escalate: false, recordIf: (c: Checked) => c.verdict !== 'insufficient' }),
        },
        sig(),
      ),
    ...extra,
  });
}

describe('sources, then common knowledge, then the web', () => {
  it('an obvious claim no source covers goes to a tiny model first and never reaches the web when it is sure', async () => {
    const r = rig({ 'openai/nano': [{ stance: 'supported', confidence: 0.95 }] });
    const search = vi.fn(async () => {});
    const out = await runOrder(r, 'Grass is green.', held(), search);
    expect(search).not.toHaveBeenCalled();
    expect(r.asked.map((a) => a.model)).toEqual(['openai/nano']);
    expect(out).toMatchObject({ verdict: 'supported', general: true, tier: 'tiny' });
  });

  it('goes to the web only when common knowledge is unsure, then judges on what the page said', async () => {
    const r = rig({
      'openai/nano': [
        { stance: 'insufficient', confidence: 0.3 },
        { stance: 'supported', confidence: 0.9 },
      ],
    });
    const g = held();
    const search = vi.fn(async () => {
      g.webDeferred = false;
      g.evidence.push(webHit());
    });
    const out = await runOrder(r, 'Ice is colder than boiling water.', g, search);
    expect(search).toHaveBeenCalledTimes(1);
    // Tiny first (no stronger model before the web), then a judgement on the evidence.
    expect(r.asked.map((a) => a.model)).toEqual(['openai/nano', 'openai/nano']);
    expect(out).toMatchObject({ verdict: 'supported', general: false });
    expect(out.evidence).toHaveLength(1);
  });

  it('keeps the common-knowledge answer when the web brings nothing back', async () => {
    const r = rig({ 'openai/nano': [{ stance: 'insufficient', confidence: 0.3 }] });
    const search = vi.fn(async () => {});
    const out = await runOrder(r, 'Grass is green.', held(), search);
    expect(search).toHaveBeenCalledTimes(1);
    expect(r.asked).toHaveLength(1);
    expect(out).toMatchObject({ verdict: 'insufficient', general: true });
  });

  it('a claim that is not obvious is searched before any model is asked', async () => {
    const r = rig({ 'anthropic/haiku': [{ stance: 'supported', confidence: 0.9 }] });
    const g = held();
    const order: string[] = [];
    const search = vi.fn(async () => {
      order.push('web');
      g.webDeferred = false;
      g.evidence.push(webHit());
    });
    // The decision layer raised the tier: not obvious, so the web comes first.
    const t = {
      ...triageClaim('Grass is green.', { critical: false }),
      obvious: false,
      tier: 'fast' as const,
    };
    const out = await checkWebLast({
      earlier: null,
      g,
      obvious: t.obvious,
      search,
      ask: async () => {
        order.push('model');
        return checkClaim(
          r.deps,
          {
            claim: 'Grass is green.',
            evidence: g.evidence,
            triage: t,
            critical: false,
            generatorFamily: null,
            notebookId: 'nb',
            sharing: false,
          },
          sig(),
        );
      },
    });
    expect(order).toEqual(['web', 'model']);
    expect(out.verdict).toBe('supported');
  });

  it('gathering holds an obvious uncovered claim back from the web and searches the others', async () => {
    const kn = {
      post: async (_p: string, body: unknown) => ({
        mode: 'hybrid',
        embedder: null,
        ms: 1,
        results: (body as { claims: string[] }).claims.map((claim) => ({ claim, hits: [], coverage: 0 })),
      }),
    };
    const web = vi.fn(
      async (_q: string) => [{ title: 'T', url: 'https://t.example/', snippet: 'Text.' }] as WebHit[],
    );
    const out = await gatherEvidence({ kn } as unknown as StepDeps, {
      workspaceId: 'w',
      notebookId: 'nb',
      claims: ['Grass is green.', 'The Fernway invoice total was 4,120 euros in March 2025.'],
      web,
      obvious: (c) => triageClaim(c, { critical: false }).obvious,
    });
    expect(web).toHaveBeenCalledTimes(1);
    expect(web.mock.calls[0]?.[0]).toMatch(/Fernway/);
    expect(out[0]).toMatchObject({ webDeferred: true, evidence: [] });
    expect(out[1]?.evidence).toHaveLength(1);
    expect(out[1]?.webTried).toBe(true);
  });
});

/* ---- Extraction ------------------------------------------------------------------ */

function extractRig(replies: string[]) {
  const asked: string[] = [];
  const ready = [nano];
  const tierOf = () => 'tiny' as ModelTier;
  const registry = {
    chain: () => ready,
    resolveWant: (want: never, ctx: object) => resolveWant(want, ready, { ...ctx, tierOf }),
    readyChat: () => ready,
    tierOf,
    get: (id: string) => ready.find((m) => m.id === id),
  };
  const queue = [...replies];
  const gateway = {
    async *stream(chain: ModelConfig[], req: { messages: { content: unknown }[] }) {
      asked.push(JSON.stringify(req.messages));
      yield { type: 'model', modelId: (chain[0] as ModelConfig).id };
      yield { type: 'chunk', chunk: { type: 'text', delta: queue.shift() ?? '{"claims":[]}' } };
    },
  } as unknown as Gateway;
  return { deps: { gateway, registry, promptsDir: '/none' } as unknown as StepDeps, asked };
}

describe('finding the claims', () => {
  const answer =
    'Mount Everest is 8,849 metres tall. The Nile is the longest river in Africa. Note: figures vary by survey.';
  const found = JSON.stringify({
    claims: [
      {
        text: 'Mount Everest is 8,849 metres tall.',
        char_start: 0,
        char_end: 35,
        importance: 1,
        checkable: true,
      },
      {
        text: 'This answer mixes survey figures.',
        char_start: 0,
        char_end: 5,
        importance: 0.2,
        checkable: true,
      },
    ],
  });

  it('counts the sentences that state something', () => {
    expect(declarativeSentences(answer)).toBe(3);
    expect(declarativeSentences('Is it blue?')).toBe(0);
    expect(declarativeSentences('Grass is green.')).toBe(1);
  });

  it('asks once more, plainly, when a first reading finds nothing in an answer with several statements', async () => {
    const r = extractRig(['{"claims":[]}', found]);
    const out = await extractClaims(r.deps, { answer, question: '' }, sig());
    expect(r.asked).toHaveLength(2);
    expect(r.asked[1]).toMatch(/first reading of this answer found no claims/);
    expect(out.retried).toBe(true);
    // Only the sentence about the answer itself is dropped; the real claim stays.
    expect(out.claims.map((c) => c.text)).toEqual(['Mount Everest is 8,849 metres tall.']);
  });

  it('an empty list is final only when the second reading agrees', async () => {
    const r = extractRig(['{"claims":[]}', '{"claims":[]}']);
    const out = await extractClaims(r.deps, { answer, question: '' }, sig());
    expect(r.asked).toHaveLength(2);
    expect(out).toMatchObject({ claims: [], retried: true });
  });

  it('does not ask again for an answer with fewer than two statements, or when claims were found', async () => {
    const one = extractRig(['{"claims":[]}']);
    expect((await extractClaims(one.deps, { answer: 'Sure.', question: '' }, sig())).claims).toEqual([]);
    expect(one.asked).toHaveLength(1);
    const some = extractRig([found]);
    await extractClaims(some.deps, { answer, question: '' }, sig());
    expect(some.asked).toHaveLength(1);
  });
});
