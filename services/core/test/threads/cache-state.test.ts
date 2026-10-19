/**
 * ------------------------------------------------------------------
 *  Title    |  Which models have this thread cached (CA12)
 *  Ref      |  ROADMAP.md CA12 · docs/prompt-caching.md
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  Fixture answers with per-call usage, a fake clock and a
 *           |  few models: warm or cold by the provider's cache
 *           |  lifetime, cost at the rate in force now (off-peak
 *           |  included), plans and local models, a provider that
 *           |  reports no cache figures, and the candidate query. Then
 *           |  the route, over a real turn.
 * ------------------------------------------------------------------
 */

import type { Message, ModelBilling, ModelConfig, UsageCall } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheState } from '../../src/threads/cache-state';
import { type Harness, harness } from '../support/harness';

const MIN = 60_000;
const T0 = Date.parse('2026-10-19T10:00:00.000Z'); // a Monday

const model = (provider: string, id: string, price: Partial<ModelConfig['price']> = {}): ModelConfig =>
  ({
    id,
    provider,
    provider_model: id,
    display_name: id,
    via: 'direct',
    family: 'test',
    context_window: 200_000,
    max_output: 8_000,
    capabilities: ['tools'],
    price: { input_per_mtok: 3, output_per_mtok: 15, ...price },
    enabled: true,
  }) as ModelConfig;

const MODELS: Record<string, ModelConfig> = {
  'anthropic/sonnet': model('anthropic', 'anthropic/sonnet'),
  'openai/gpt': model('openai', 'openai/gpt', { input_per_mtok: 1 }),
  'deepseek/flash': model('deepseek', 'deepseek/flash', {
    input_per_mtok: 0.3,
    // Half price from 11:00 to 13:00 UTC on weekdays.
    off_peak: {
      windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '11:00', to: '13:00' }],
      input_per_mtok: 0.15,
      output_per_mtok: 0.5,
    },
  }),
  'mistral/large': model('mistral', 'mistral/large', { input_per_mtok: 2 }),
  'claude_code/opus': model('claude_code', 'claude_code/opus'),
  'ollama/llama': model('ollama', 'ollama/llama', { input_per_mtok: 0 }),
  'groq/fast': model('groq', 'groq/fast', { input_per_mtok: 0.5 }),
};
const BILLING: Record<string, ModelBilling> = {
  'claude_code/opus': { kind: 'plan', payer: 'max' },
  'ollama/llama': { kind: 'local', payer: null },
};
const deps = {
  exact: (id: string) => MODELS[id],
  get: (id: string) => MODELS[id],
  billingFor: (id: string) => BILLING[id] ?? { kind: 'key' as const, payer: MODELS[id]?.provider ?? null },
};

/** An answer that started at `at` (ms) and made these calls (offsets from its start). */
function answer(
  at: number,
  calls: Partial<UsageCall>[],
  reported = true,
): { created_at: string; status: 'complete'; usage: Message['usage'] } {
  return {
    created_at: new Date(at).toISOString(),
    status: 'complete',
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      cost_usd: 0,
      cache_reported: reported,
      calls: calls.map((c) => ({
        model_id: 'anthropic/sonnet',
        started_ms: 0,
        ms: 2_000,
        input_tokens: 10_000,
        cached_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 500,
        cost_usd: 0,
        ...c,
      })),
    },
  };
}

describe('which models have the thread cached', () => {
  it('Anthropic is warm for five minutes after the call that wrote or read the cache', () => {
    const msgs = [answer(T0, [{ cache_write_tokens: 9_000, input_tokens: 10_000 }])];
    const warm = cacheState(msgs, deps, T0 + 4 * MIN);
    expect(warm.items[0]).toMatchObject({
      model_id: 'anthropic/sonnet',
      provider: 'anthropic',
      warm_until: new Date(T0 + 2_000 + 5 * MIN).toISOString(),
      prefix_tokens: 9_000,
      reported: true,
    });
    const cold = cacheState(msgs, deps, T0 + 8 * MIN);
    expect(cold.items[0]).toMatchObject({ warm_until: null, prefix_tokens: 9_000 });
  });

  it('prices catching up at the fresh input rate of that model', () => {
    const msgs = [answer(T0, [{ cached_tokens: 8_000, cache_write_tokens: 1_000 }])];
    const s = cacheState(msgs, deps, T0 + 60_000);
    // 9,000 tokens at $3 per million.
    expect(s.items[0]?.cold_cost_usd).toBeCloseTo(0.027, 6);
  });

  it('uses the off-peak price when now is inside the window', () => {
    const at = Date.parse('2026-10-19T09:00:00.000Z');
    const msgs = [
      answer(at, [{ model_id: 'deepseek/flash', cached_tokens: 100_000, input_tokens: 100_000 }]),
    ];
    const peak = cacheState(msgs, deps, Date.parse('2026-10-19T09:30:00.000Z'));
    expect(peak.items[0]?.cold_cost_usd).toBeCloseTo(0.03, 6); // 100k at $0.30
    const off = cacheState(msgs, deps, Date.parse('2026-10-19T11:30:00.000Z'));
    expect(off.items[0]?.cold_cost_usd).toBeCloseTo(0.015, 6); // 100k at $0.15
    // DeepSeek's cache lasts hours: still warm at 09:30, a long way on from the call.
    expect(peak.items[0]?.warm_until).not.toBeNull();
    expect(peak.items[0]?.ttl_assumed).toBe(true);
  });

  it('gives a plan no cost, and a local model none but time', () => {
    const msgs = [
      answer(T0, [
        { model_id: 'claude_code/opus', input_tokens: 5_000 },
        { model_id: 'ollama/llama', started_ms: 3_000, input_tokens: 4_000 },
      ]),
    ];
    const s = cacheState(msgs, deps, T0 + 10_000);
    const byId = Object.fromEntries(s.items.map((i) => [i.model_id, i]));
    expect(byId['claude_code/opus']).toMatchObject({ cold_cost_usd: null, plan: true });
    expect(byId['ollama/llama']).toMatchObject({ cold_cost_usd: 0, local: true });
  });

  it('guesses from the last call when a provider reports no cache figures, and says so', () => {
    const msgs = [answer(T0, [{ model_id: 'groq/fast', input_tokens: 6_000 }], false)];
    const s = cacheState(msgs, deps, T0 + 60_000);
    expect(s.items[0]).toMatchObject({ reported: false, prefix_tokens: 6_000 });
    expect(s.items[0]?.warm_until).not.toBeNull();
    // Groq's cache lasts two hours.
    const later = cacheState(msgs, deps, T0 + 3 * 60 * MIN);
    expect(later.items[0]?.warm_until).toBeNull();
  });

  it('a provider that reports figures and read nothing is cold, whatever the clock says', () => {
    const msgs = [answer(T0, [{ model_id: 'openai/gpt', input_tokens: 500 }])];
    const s = cacheState(msgs, deps, T0 + 1_000);
    expect(s.items[0]).toMatchObject({ warm_until: null, reported: true, prefix_tokens: 500 });
  });

  it('lists the most recently used model first, one entry per model, from its latest call', () => {
    const msgs = [
      answer(T0, [{ model_id: 'anthropic/sonnet', cache_write_tokens: 1_000 }]),
      answer(T0 + 10 * MIN, [{ model_id: 'openai/gpt', cached_tokens: 2_000, input_tokens: 3_000 }]),
      answer(T0 + 12 * MIN, [{ model_id: 'anthropic/sonnet', cached_tokens: 7_000, input_tokens: 8_000 }]),
    ];
    const s = cacheState(msgs, deps, T0 + 13 * MIN);
    expect(s.items.map((i) => i.model_id)).toEqual(['anthropic/sonnet', 'openai/gpt']);
    expect(s.items[0]?.prefix_tokens).toBe(7_000);
    // The thread is as long as the newest call's prompt plus its answer.
    expect(s.thread_tokens).toBe(8_000 + 500);
  });

  it('answers a candidate: warm if the thread is cached on it, else what reading it all would cost', () => {
    const msgs = [answer(T0, [{ cache_write_tokens: 9_000 }])];
    const warm = cacheState(msgs, deps, T0 + MIN, 'anthropic/sonnet');
    expect(warm.candidate).toMatchObject({ model_id: 'anthropic/sonnet', warm: true, prefix_tokens: 10_500 });
    const cold = cacheState(msgs, deps, T0 + MIN, 'mistral/large');
    expect(cold.candidate).toMatchObject({ model_id: 'mistral/large', warm: false, prefix_tokens: 10_500 });
    expect(cold.candidate?.cold_cost_usd).toBeCloseTo(0.021, 6);
    expect(cacheState(msgs, deps, T0, 'claude_code/opus').candidate).toMatchObject({
      cold_cost_usd: null,
      plan: true,
    });
    expect(cacheState(msgs, deps, T0, 'ollama/llama').candidate).toMatchObject({
      cold_cost_usd: 0,
      local: true,
    });
    expect(cacheState(msgs, deps, T0, 'nope/none').candidate).toBeUndefined();
  });

  it('is empty for a thread with no per-call usage', () => {
    expect(cacheState([], deps, T0)).toEqual({ items: [], thread_tokens: 0 });
  });
});

describe('GET /threads/:id/cache-state', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('lists the model that answered, and refuses a candidate that does not exist', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, '/say hello');
    await h.settle(sent.run_id);
    const r = await h.call<{
      items: { model_id: string; reported: boolean; warm_until: string | null }[];
      thread_tokens: number;
    }>('GET', `/threads/${t}/cache-state`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]?.reported).toBe(false);
    // (The in-memory store stamps messages with its own clock, so warmth is covered above.)
    expect(r.body.thread_tokens).toBeGreaterThan(0);
    const missing = await h.call('GET', `/threads/${t}/cache-state?candidate=nope%2Fnone`);
    expect(missing.status).toBe(404);
    const unknown = await h.call('GET', '/threads/thr_01MISSING00000000000000000/cache-state');
    expect(unknown.status).toBe(404);
  });
});
