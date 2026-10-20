/**
 * Fact-check web search through a model: the chain's order, SearXNG first,
 * a route that fails handing over to the next, what each lookup costs, and
 * the daily cap. Fakes only: no search or model API is ever called.
 */
import { AncileError, type ModelConfig } from '@nvx/contracts';
import { describe, expect, it, vi } from 'vitest';
import { gatedWeb, newTally, tallyOutcome, type WebHit, type WebSearch } from '../../src/factcheck/web';
import { parseHitList, WEB_SPEND_SETTING, webSearchChain } from '../../src/factcheck/web-models';
import { MemorySettings } from '../../src/settings';
import { fakeModel } from '../gateway/fake-provider';

const model = (provider: string, id: string, input: number, output: number, secret: string): ModelConfig => ({
  ...fakeModel(id, 'script'),
  id: `${provider}/${id}`,
  provider,
  provider_model: id,
  price: { input_per_mtok: input, output_per_mtok: output },
  secret,
});
const GEMINI = model('google', 'gemini-3.5-flash-lite', 0.3, 2.5, 'GOOGLE_GENERATIVE_AI_API_KEY');
const ROUTER = model('openrouter', 'anthropic/claude-haiku-5.5', 0.1, 0.5, 'OPENROUTER_API_KEY');
const ROUTER_BIG = model('openrouter', 'openai/big', 5, 15, 'OPENROUTER_API_KEY');
const HAIKU = model('anthropic', 'claude-haiku-5-5', 0.1, 0.5, 'ANTHROPIC_API_KEY');
const OPUS = model('anthropic', 'claude-opus-5-5', 10, 50, 'ANTHROPIC_API_KEY');

const LIST = JSON.stringify([
  {
    title: 'Sundew anemometer',
    url: 'https://weather.example/sundew',
    snippet: 'Reads wind speed in knots.',
  },
  { title: 'Not a link', url: 'javascript:alert(1)', snippet: 'x' },
]);

const reply = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

/** A fake of every provider's endpoint, by host; counts the calls it received. */
function fakeNet(over: Partial<Record<'google' | 'openrouter' | 'anthropic', () => Promise<Response>>> = {}) {
  const calls: { host: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const host = new URL(String(input)).hostname;
    calls.push({ host, body: JSON.parse(String(init?.body ?? '{}')) });
    if (host.startsWith('generativelanguage'))
      return (
        over.google?.() ??
        reply({
          candidates: [{ content: { parts: [{ text: LIST }] } }],
          usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 200 },
        })
      );
    if (host.startsWith('openrouter'))
      return (
        over.openrouter?.() ??
        reply({
          choices: [
            {
              message: {
                content: 'no list here',
                annotations: [
                  {
                    type: 'url_citation',
                    url_citation: { url: 'https://or.example/a', title: 'A', content: 'Excerpt A' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 500, completion_tokens: 100 },
        })
      );
    return (
      over.anthropic?.() ??
      reply({
        content: [{ type: 'text', text: LIST }],
        usage: { input_tokens: 800, output_tokens: 150, server_tool_use: { web_search_requests: 1 } },
      })
    );
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function chain(a: {
  models: ModelConfig[];
  cap?: number;
  searxng?: WebSearch | null;
  net?: ReturnType<typeof fakeNet>;
  keys?: Record<string, string>;
  settings?: MemorySettings;
}) {
  const net = a.net ?? fakeNet();
  const settings = a.settings ?? new MemorySettings();
  const keys = a.keys ?? {
    GOOGLE_GENERATIVE_AI_API_KEY: 'g',
    OPENROUTER_API_KEY: 'o',
    ANTHROPIC_API_KEY: 'a',
  };
  return {
    net,
    settings,
    web: webSearchChain({
      models: () => a.models,
      secret: async (n) => keys[n],
      settings,
      capUsd: () => a.cap ?? 0.25,
      searxng: a.searxng,
      fetch: net.fetcher,
      now: () => new Date(2026, 9, 20, 12),
    }),
  };
}

const sig = () => new AbortController().signal;

describe('the web search chain', () => {
  it('prefers SearXNG when it is set, and never calls a model', async () => {
    const hit: WebHit = { title: 't', url: 'https://x.example', snippet: 's' };
    const searxng: WebSearch = { search: vi.fn(async () => [hit]) };
    const c = chain({ models: [GEMINI, ROUTER, HAIKU], searxng });
    expect(await c.web.status?.()).toMatchObject({ ready: true, via: 'searxng' });
    expect(await c.web.search('q', sig())).toEqual([hit]);
    expect(c.net.calls).toEqual([]);
  });

  it('tries the cheapest route first: Gemini, then OpenRouter, then Claude', async () => {
    const all = chain({ models: [HAIKU, ROUTER, GEMINI] });
    expect(await all.web.status?.()).toMatchObject({ ready: true, via: 'google' });
    await all.web.search('q', sig());
    expect(all.net.calls.map((x) => x.host)).toEqual(['generativelanguage.googleapis.com']);

    const noGoogle = chain({ models: [HAIKU, ROUTER] });
    await noGoogle.web.search('q', sig());
    expect(noGoogle.net.calls.map((x) => x.host)).toEqual(['openrouter.ai']);

    const onlyClaude = chain({ models: [HAIKU, OPUS] });
    const hits = await onlyClaude.web.search('q', sig());
    expect(onlyClaude.net.calls.map((x) => x.host)).toEqual(['api.anthropic.com']);
    // The cheapest Haiku, not Opus, and the basic search tool limited to one use.
    expect(onlyClaude.net.calls[0]?.body).toMatchObject({
      model: 'claude-haiku-5-5',
      tools: [{ type: 'web_search_20250305', max_uses: 1 }],
    });
    expect(hits).toEqual([
      {
        title: 'Sundew anemometer',
        url: 'https://weather.example/sundew',
        snippet: 'Reads wind speed in knots.',
      },
    ]);
  });

  it('uses the cheapest ready model of a route, Flash-Lite only for Gemini, Exa for OpenRouter', async () => {
    const c = chain({ models: [ROUTER_BIG, ROUTER] });
    await c.web.search('q', sig());
    expect(c.net.calls[0]?.body).toMatchObject({
      model: 'anthropic/claude-haiku-5.5',
      plugins: [{ id: 'web', engine: 'exa' }],
    });
    const pro = chain({ models: [model('google', 'gemini-3.5-pro', 1, 5, 'GOOGLE_GENERATIVE_AI_API_KEY')] });
    expect(await pro.web.status?.()).toEqual({ ready: false, reason: 'none' });
  });

  it('hands over to the next route when one fails, returning WebHits from the fallback', async () => {
    const c = chain({
      models: [GEMINI, ROUTER],
      net: fakeNet({ google: () => reply({ error: 'no' }, 500) }),
    });
    const hits = await c.web.search('q', sig());
    expect(c.net.calls.map((x) => x.host)).toContain('openrouter.ai');
    // OpenRouter's own citations stand in when the model wrote no list.
    expect(hits).toEqual([{ title: 'A', url: 'https://or.example/a', snippet: 'Excerpt A' }]);
  });

  it('says so when every route fails, and when no key or model is ready', async () => {
    const down = chain({ models: [GEMINI], net: fakeNet({ google: () => reply({}, 500) }) });
    await expect(down.web.search('q', sig())).rejects.toMatchObject({ code: 'factcheck.web_unavailable' });
    const none = chain({ models: [] });
    expect(await none.web.status?.()).toEqual({ ready: false, reason: 'none' });
    await expect(none.web.search('q', sig())).rejects.toBeInstanceOf(AncileError);
    const noKey = chain({ models: [GEMINI], keys: {} });
    await expect(noKey.web.search('q', sig())).rejects.toMatchObject({ code: 'factcheck.web_unavailable' });
  });

  it('adds what a search cost to the tally and to the day, and counts the Gemini free allowance', async () => {
    const c = chain({ models: [GEMINI] });
    const tally = newTally();
    await c.web.search('q', sig(), tally);
    // Free allowance: tokens only (1,000 in at $0.30 and 200 out at $2.50 per million).
    expect(tally.costUsd).toBeCloseTo(0.0008, 6);
    expect(await c.web.spentToday?.()).toBeCloseTo(0.0008, 6);
    expect(await c.settings.get(WEB_SPEND_SETTING)).toMatchObject({ day: '2026-10-20', g3: 1 });

    const claude = chain({ models: [HAIKU] });
    const t2 = newTally();
    await claude.web.search('q', sig(), t2);
    expect(t2.costUsd).toBeCloseTo(0.01 + (800 * 0.1 + 150 * 0.5) / 1e6, 6);

    const or = chain({ models: [ROUTER] });
    const t3 = newTally();
    await or.web.search('q', sig(), t3);
    expect(t3.costUsd).toBeCloseTo(0.007 + (500 * 0.1 + 100 * 0.5) / 1e6, 6);
  });

  it('charges the Gemini search fee once the free allowance for the month is used', async () => {
    const settings = new MemorySettings();
    await settings.set(WEB_SPEND_SETTING, { day: '2026-10-20', usd: 0, month: '2026-10', g3: 5_000, g2: 0 });
    const c = chain({ models: [GEMINI], settings });
    const t = newTally();
    await c.web.search('q', sig(), t);
    expect(t.costUsd).toBeGreaterThan(0.014);
  });

  it('stops at the daily cap, says so, and starts again the next day', async () => {
    const settings = new MemorySettings();
    await settings.set(WEB_SPEND_SETTING, { day: '2026-10-20', usd: 0.249, month: '2026-10', g3: 0, g2: 0 });
    const c = chain({ models: [HAIKU], settings });
    expect(await c.web.status?.()).toMatchObject({ ready: true });
    // 0.249 spent and a Claude search is expected to cost 0.012: over the 0.25 cap.
    await expect(c.web.search('q', sig())).rejects.toMatchObject({ code: 'factcheck.web_budget' });
    expect(c.net.calls).toEqual([]);

    await settings.set(WEB_SPEND_SETTING, { day: '2026-10-20', usd: 0.25, month: '2026-10', g3: 0, g2: 0 });
    expect(await c.web.status?.()).toEqual({ ready: false, reason: 'budget' });

    // Yesterday's spend does not count today.
    await settings.set(WEB_SPEND_SETTING, { day: '2026-10-19', usd: 9, month: '2026-10', g3: 0, g2: 0 });
    expect(await c.web.status?.()).toMatchObject({ ready: true });
    await expect(c.web.search('q', sig())).resolves.toHaveLength(1);
  });

  it('a cap of 0 turns model lookups off', async () => {
    const c = chain({ models: [GEMINI], cap: 0 });
    expect(await c.web.status?.()).toEqual({ ready: false, reason: 'budget' });
    await expect(c.web.search('q', sig())).rejects.toMatchObject({ code: 'factcheck.web_budget' });
  });

  it('keeps searches running side by side inside the cap', async () => {
    const c = chain({ models: [HAIKU], cap: 0.025 });
    const out = await Promise.allSettled([1, 2, 3, 4].map((i) => c.web.search(`q${i}`, sig(), newTally())));
    const ok = out.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(2);
    expect(await c.web.spentToday?.()).toBeLessThanOrEqual(0.025);
  });
});

describe('what a check reports about its lookups', () => {
  const ctx = { threadId: 't', notebookId: null, workspaceId: 'w', runId: null, traceId: 'tr' };
  const allow = {
    check: vi.fn(async () => ({
      outcome: 'allow' as const,
      via: 'grant' as const,
      tier: 'gated' as const,
      resource: '',
    })),
  };

  it('asks the permission gate on the real query before anything leaves, and counts a refusal', async () => {
    const search = vi.fn(async () => []);
    const ask = {
      check: vi.fn(async () => ({ outcome: 'ask' as const, tier: 'gated' as const, resource: '' })),
    };
    const tally = newTally();
    const look = gatedWeb({ web: { search }, gate: ask as never, userId: 'u', ctx, tally });
    expect(await look?.('is the sky blue', sig())).toBeNull();
    expect(ask.check).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'web.search', resource: 'web:search/is the sky blue' }),
    );
    expect(search).not.toHaveBeenCalled();
    expect(tallyOutcome(tally)).toMatchObject({
      reason: 'blocked',
      note: expect.stringMatching(/not allowed/),
    });
  });

  it('reports the daily budget, a search that did not answer, and nothing when all was well', async () => {
    const budget = newTally();
    const spent: WebSearch = {
      search: async () => {
        throw new AncileError({ code: 'factcheck.web_budget', title: 't', hint: 'h' });
      },
    };
    await gatedWeb({ web: spent, gate: allow as never, userId: 'u', ctx, tally: budget })?.('q', sig());
    expect(tallyOutcome(budget)).toEqual({
      reason: 'budget',
      note: 'Not checked on the web: the daily web budget is reached.',
    });

    const failed = newTally();
    const broken: WebSearch = {
      search: async () => {
        throw new Error('down');
      },
    };
    await gatedWeb({ web: broken, gate: allow as never, userId: 'u', ctx, tally: failed })?.('q', sig());
    expect(tallyOutcome(failed)).toMatchObject({ reason: 'failed' });

    const fine = newTally();
    const ok: WebSearch = { search: async () => [] };
    await gatedWeb({ web: ok, gate: allow as never, userId: 'u', ctx, tally: fine })?.('q', sig());
    expect(tallyOutcome(fine)).toBeNull();
    expect(fine.searches).toBe(1);

    // Some claims searched, then the budget ran out: said as partial, not as nothing.
    fine.budget = true;
    expect(tallyOutcome(fine)?.note).toMatch(/Some claims were not checked/);
  });
});

describe('reading what a model sends back', () => {
  it('keeps only public web links, trimmed, at most five', () => {
    expect(parseHitList(`Here you go: ${LIST} done`)).toHaveLength(1);
    expect(parseHitList('no json')).toEqual([]);
    expect(parseHitList('[not json]')).toEqual([]);
    const many = JSON.stringify(
      Array.from({ length: 9 }, (_, i) => ({ title: `t${i}`, url: `https://e.example/${i}`, snippet: 's' })),
    );
    expect(parseHitList(many)).toHaveLength(5);
  });
});
