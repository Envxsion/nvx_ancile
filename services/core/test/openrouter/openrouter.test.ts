/**
 * ------------------------------------------------------------------
 *  Title    |  OpenRouter: endpoints, routing, cost, served, Auto
 *  Ref      |  docs/openrouter.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Each preset builds the exact provider object; Auto
 *           |  Exacto is kept only when nothing orders or sorts;
 *           |  endpoint warnings read as plain words; cost maths is
 *           |  cache-aware; the served provider is read and recorded;
 *           |  Auto never overflows; vLLM and Ollama estimates.
 *  How      |  Recorded fixture (fixtures/openrouter-endpoints.json:
 *           |  three real qwen3-coder endpoints from OpenRouter's
 *           |  public API, plus one made-up short "Tiny" endpoint).
 *           |  No network: the cache gets a fake fetch.
 * ------------------------------------------------------------------
 */

import { readFileSync } from 'node:fs';
import {
  type ModelConfig,
  memoryEstimateGb,
  OpenRouterFile,
  RoutingSettings,
  UsageReport,
  vllmEnv,
  vramFit,
} from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { readServed, servedExtractor } from '../../src/gateway/providers';
import { advise, guessKind } from '../../src/openrouter/advisor';
import { AUTO_SAFE_WINDOW, autoLimits } from '../../src/openrouter/auto';
import { estimateCost } from '../../src/openrouter/cost';
import { EndpointsCache, parseEndpoints } from '../../src/openrouter/endpoints';
import { buildRouting, turnCostUsd } from '../../src/openrouter/routing';
import { estimateTokens, OpenRouterService } from '../../src/openrouter/service';
import { MemorySettings } from '../../src/settings';
import { buildReport, MemoryUsageSource, usageHistory, window } from '../../src/usage/report';

const body = JSON.parse(
  readFileSync(new URL('../fixtures/openrouter-endpoints.json', import.meta.url), 'utf8'),
);
const cfg = OpenRouterFile.parse({
  version: 1,
  precision: [
    {
      model: 'qwen/qwen3-coder',
      precision: 'bf16',
      context: 262144,
      source: 'https://huggingface.co/Qwen/Qwen3-Coder-480B-A35B-Instruct',
    },
  ],
  trusted: [{ model: 'qwen/qwen3-coder', providers: ['Venice'] }],
});
const report = parseEndpoints(body, cfg);
const eps = report.endpoints;
const S = (o: Partial<RoutingSettings> = {}) => RoutingSettings.parse(o);
const need = { context: 30_000, output: 8_000, tools: true };

describe('endpoint explorer', () => {
  it('reads precision, context share, output cap, tools, prices and uptime', () => {
    expect(report.native_context).toBe(262144);
    const deep = eps.find((e) => e.provider === 'DeepInfra');
    expect(deep).toMatchObject({
      precision: 'fp4',
      original_precision: false,
      context_pct: 100,
      max_output: 65536,
      tools: true,
      price: { input: 0.3, output: 1, cache_read: 0.1, cache_write: null },
      uptime: 100,
    });
    expect(eps.find((e) => e.provider === 'Google')?.original_precision).toBeNull();
  });

  it('warns in words', () => {
    const tiny = eps.find((e) => e.provider === 'Tiny');
    const texts = tiny?.warnings.map((w) => w.text) ?? [];
    expect(texts).toContain('This endpoint can only read 9% of what the model can.');
    expect(texts).toContain('Answers capped at 4,096 tokens: reasoning will be cut off.');
    expect(texts).toContain("Can't use tools.");
    expect(tiny?.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['low_uptime', 'no_cache_price']),
    );
    expect(eps.find((e) => e.provider === 'Google')?.warnings.map((w) => w.code)).toContain(
      'unknown_precision',
    );
    expect(eps.find((e) => e.provider === 'Venice')?.warnings.map((w) => w.code)).toEqual([
      'not_original_precision',
    ]);
  });

  it('caches with a TTL and answers offline from the saved copy', async () => {
    let calls = 0;
    let down = false;
    let t = 0;
    const settings = new MemorySettings();
    const fetchJson = async () => {
      calls++;
      if (down) throw new Error('offline');
      return body;
    };
    const cache = new EndpointsCache({ settings, fetchJson, config: () => cfg, now: () => t });
    expect((await cache.report('qwen/qwen3-coder')).offline).toBe(false);
    await cache.report('qwen/qwen3-coder:floor');
    expect(calls).toBe(1);
    t = 31 * 60_000;
    down = true;
    const fresh = new EndpointsCache({ settings, fetchJson, config: () => cfg, now: () => t });
    const r = await fresh.report('qwen/qwen3-coder');
    expect(r.offline).toBe(true);
    expect(r.endpoints).toHaveLength(4);
    await expect(fresh.report('other/model')).rejects.toMatchObject({
      code: 'openrouter.endpoints_unavailable',
    });
    await expect(fresh.report('not a model')).rejects.toMatchObject({ code: 'openrouter.model_invalid' });
    expect((await fresh.report('openrouter/auto')).endpoints).toEqual([]);
  });
});

describe('routing presets', () => {
  const base = {
    model: 'qwen/qwen3-coder',
    endpoints: eps,
    need,
    modelMaxOutput: 16_000,
    trusted: ['Venice'],
  };

  it('recommended keeps Auto Exacto, requires parameters, sets max_tokens, leaves out too-small endpoints', () => {
    const r = buildRouting({ ...base, settings: S() });
    expect(r.provider).toEqual({ require_parameters: true, ignore: ['Tiny'] });
    expect(r.max_tokens).toBe(16_000);
    expect(r.auto_exacto).toBe(true);
  });

  it('best quality pins trusted then original-precision providers only', () => {
    const r = buildRouting({ ...base, settings: S({ preset: 'best_quality' }) });
    expect(r.provider).toEqual({
      require_parameters: true,
      order: ['Venice', 'Google'],
      only: ['Venice', 'Google'],
      ignore: ['Tiny'],
    });
    expect(r.auto_exacto).toBe(false);
    expect(r.notes.join(' ')).toContain('Auto Exacto no longer chooses');
  });

  it('lowest real cost ranks by cache-aware cost, not list price', () => {
    const cold = buildRouting({
      ...base,
      settings: S({ preset: 'lowest_cost' }),
      history: { cacheHitRate: 0, inputShare: 0.9 },
    });
    expect(cold.provider.order).toEqual(['DeepInfra', 'Google', 'Venice']);
    const warm = buildRouting({
      ...base,
      settings: S({ preset: 'lowest_cost' }),
      history: { cacheHitRate: 0.9, inputShare: 0.98 },
    });
    expect(warm.provider).toEqual({
      require_parameters: true,
      order: ['Venice', 'DeepInfra', 'Google'],
      allow_fallbacks: true,
      ignore: ['Tiny'],
    });
    expect(warm.provider.sort).toBeUndefined();
  });

  it('fastest sorts by throughput', () => {
    const r = buildRouting({ ...base, settings: S({ preset: 'fastest' }) });
    expect(r.provider).toEqual({ require_parameters: true, sort: 'throughput', ignore: ['Tiny'] });
    expect(r.auto_exacto).toBe(false);
  });

  it('pinned uses only the chosen providers in order, no fallbacks', () => {
    const r = buildRouting({
      ...base,
      settings: S({ preset: 'pinned', providers: ['DeepInfra', 'Google'] }),
    });
    expect(r.provider).toEqual({
      require_parameters: true,
      order: ['DeepInfra', 'Google'],
      only: ['DeepInfra', 'Google'],
      allow_fallbacks: false,
      ignore: ['Tiny'],
    });
  });

  it('precision floor, data collection and avoided providers', () => {
    const r = buildRouting({
      ...base,
      settings: S({ min_precision: 'fp8', deny_data_collection: true, avoid: ['Google'] }),
    });
    expect(r.provider).toEqual({
      require_parameters: true,
      ignore: ['Google', 'Tiny'],
      quantizations: ['int8', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32'],
      data_collection: 'deny',
    });
    expect(r.auto_exacto).toBe(true);
  });

  it('advanced is sent exactly; price sort and :floor turn Auto Exacto off', () => {
    const adv = buildRouting({
      ...base,
      settings: S({ preset: 'advanced', advanced: { sort: 'price', allow_fallbacks: false } }),
    });
    expect(adv.provider).toEqual({ sort: 'price', allow_fallbacks: false });
    expect(adv.auto_exacto).toBe(false);
    expect(adv.notes.join(' ')).toContain('Sorting by price turns Auto Exacto off');
    const floor = buildRouting({ ...base, model: 'qwen/qwen3-coder:floor', settings: S() });
    expect(floor.auto_exacto).toBe(false);
    expect(floor.notes.join(' ')).toContain(':floor');
  });

  it('builds without endpoints (offline, or Auto)', () => {
    const r = buildRouting({ ...base, endpoints: null, settings: S({ max_tokens: 2_000 }) });
    expect(r.provider).toEqual({ require_parameters: true });
    expect(r.max_tokens).toBe(2_000);
  });

  it('resolves flow step, thread, notebook, model, then Recommended', async () => {
    const settings = new MemorySettings();
    const svc = new OpenRouterService({
      settings,
      endpoints: new EndpointsCache({ settings, fetchJson: async () => body, config: () => cfg }),
      config: () => cfg,
      models: () => undefined,
    });
    expect((await svc.resolve({ modelId: 'm' })).preset).toBe('recommended');
    await svc.setOverride('model', 'm', S({ preset: 'fastest' }));
    await svc.setOverride('notebook', 'nb', S({ preset: 'pinned' }));
    expect((await svc.resolve({ modelId: 'm' })).preset).toBe('fastest');
    expect((await svc.resolve({ modelId: 'm', notebookId: 'nb' })).preset).toBe('pinned');
    await svc.setOverride('thread', 't', S({ preset: 'best_quality' }));
    expect((await svc.resolve({ modelId: 'm', notebookId: 'nb', threadId: 't' })).preset).toBe(
      'best_quality',
    );
    expect(
      (await svc.resolve({ modelId: 'm', threadId: 't', explicit: S({ preset: 'lowest_cost' }) })).preset,
    ).toBe('lowest_cost');
    const call = await svc.forCall(
      {
        id: 'openrouter/qwen3-coder',
        provider: 'openrouter',
        provider_model: 'qwen/qwen3-coder',
        max_output: 16_000,
      } as ModelConfig,
      {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'x', description: 'x', inputSchema: {} }],
      },
    );
    expect(call?.provider).toEqual({ require_parameters: true, ignore: ['Tiny'] });
    expect(await svc.forCall({ provider: 'anthropic' } as ModelConfig, { messages: [] })).toBeNull();
    expect(estimateTokens({ system: 'x'.repeat(400), messages: [] })).toBe(100);
  });
});

describe('cost', () => {
  it('a turn counts cache reads at the cache price', () => {
    const price = { input: 1, output: 4, cache_read: 0.1, cache_write: 1.25 };
    expect(turnCostUsd(price, { input: 1_000_000, output: 0, hitRate: 0.5 })).toBeCloseTo(0.55, 6);
    expect(
      turnCostUsd(price, { input: 0, output: 1_000_000, cacheWrite: 1_000_000, hitRate: 0 }),
    ).toBeCloseTo(5.25, 6);
  });

  it('ranks by real invoice, uses history for the hit rate, and compares RunPod and Claude Code', () => {
    const r = estimateCost(
      {
        model: 'qwen/qwen3-coder',
        input_tokens: 30_000,
        output_tokens: 1_000,
        cache_write_tokens: 0,
        cache_hit_rate: null,
        messages_per_day: 100,
        gpu_usd_per_hour: 1,
        gpu_tokens_per_second: 50,
      },
      { ...report, fetched_at: '', offline: false },
      {
        history: {
          rows: [
            {
              model_id: 'qwen/qwen3-coder',
              provider: 'Venice',
              answers: 10,
              input_tokens: 1000,
              output_tokens: 100,
              cached_tokens: 800,
              cache_hit_rate: 0.8,
              input_share: 0.9,
            },
          ],
        },
        planKnown: true,
        planUsedPercent: 40,
      },
    );
    expect(r.cache_hit_from).toBe('history');
    expect(r.cache_hit_rate).toBeCloseTo(0.8);
    expect(r.rows.map((x) => x.provider)).toEqual(['Venice', 'DeepInfra', 'Google', 'Tiny']);
    const google = r.rows.find((x) => x.provider === 'Google');
    expect(google?.list_per_turn).toBeLessThan(r.rows[0]?.list_per_turn ?? 0);
    expect(r.rows.find((x) => x.provider === 'Tiny')?.fits).toBe(false);
    const venice = r.rows[0];
    expect(venice?.per_month).toBeCloseTo((venice?.per_turn ?? 0) * 3000, 5);
    expect(r.runpod?.break_even_tokens_per_month).toBeGreaterThan(0);
    expect(r.runpod?.hours_needed_per_month).toBeCloseTo(16.7, 1);
    expect(r.claude_code?.used_percent).toBe(40);
  });
});

describe('which provider served', () => {
  it('reads provider, model and billed cost off the stream', () => {
    const x = servedExtractor.createStreamExtractor();
    x.processChunk({ id: 'g', provider: 'DeepInfra', model: 'qwen/qwen3-coder', choices: [] });
    x.processChunk({ choices: [], usage: { prompt_tokens: 1, cost: 0.0012 } });
    expect(x.buildMetadata()).toEqual({
      openrouter: { provider: 'DeepInfra', model: 'qwen/qwen3-coder', cost: 0.0012 },
      // The raw usage rides along, so cache hits under any name are counted (CA0).
      raw: { usage: { prompt_tokens: 1, cost: 0.0012 } },
    });
    const s = { provider: null, model: null, cost: null };
    readServed(s, 'nonsense');
    expect(s.provider).toBeNull();
  });

  it('Usage reports and filters by the provider that served', async () => {
    const at = '2026-10-12T10:00:00.000Z';
    const msg = (id: string, provider: string | null, input: number) => ({
      id,
      thread_id: 't',
      model_id: 'openrouter/qwen3-coder',
      run_id: null,
      provenance: {},
      created_at: at,
      usage: {
        input_tokens: input,
        output_tokens: 10,
        cached_tokens: input / 2,
        cost_usd: 0.01,
        ...(provider && { served: { provider, model: 'qwen/qwen3-coder', cut_off: false } }),
      },
    });
    const source = new MemoryUsageSource({
      messages: () => [msg('a', 'DeepInfra', 100), msg('b', 'Venice', 200), msg('c', null, 50)] as never,
      workspaceOf: () => 'w',
      runKind: () => null,
    });
    const now = Date.parse('2026-10-12T12:00:00Z');
    const w = window('day', 'UTC', now);
    const all = buildReport(
      'day',
      'UTC',
      w,
      await source.rows({ workspaceId: 'w', tz: 'UTC', bucket: w.bucket, from: w.from, to: w.to }),
    );
    expect(UsageReport.parse(all).by_provider.map((p) => p.provider)).toEqual(['Venice', 'DeepInfra']);
    const one = await source.rows({
      workspaceId: 'w',
      tz: 'UTC',
      bucket: w.bucket,
      from: w.from,
      to: w.to,
      provider: 'Venice',
    });
    expect(one).toHaveLength(1);
    const h = await usageHistory(source, 'w', now);
    expect(h.rows.find((r) => r.provider === 'Venice')?.cache_hit_rate).toBe(0.5);
  });
});

describe('openrouter/auto', () => {
  const auto = {
    id: 'openrouter/auto',
    provider: 'openrouter',
    provider_model: 'openrouter/auto',
    context_window: 2_000_000,
    max_output: 100_000,
  } as ModelConfig;

  it('plans for the smallest plausible window; a served window only narrows it', () => {
    expect(autoLimits(auto).context_window).toBe(AUTO_SAFE_WINDOW);
    expect(autoLimits(auto, 16_000).context_window).toBe(16_000);
    expect(autoLimits(auto, 1_000_000).context_window).toBe(AUTO_SAFE_WINDOW);
    const other = { ...auto, provider_model: 'qwen/qwen3-coder' };
    expect(autoLimits(other)).toBe(other);
  });

  it('routing for Auto skips endpoint exclusions but keeps the general fields', () => {
    const r = buildRouting({
      model: 'openrouter/auto',
      settings: S({ deny_data_collection: true }),
      endpoints: null,
      need,
      modelMaxOutput: 8_192,
    });
    expect(r.provider).toEqual({ require_parameters: true, data_collection: 'deny' });
    expect(r.auto_exacto).toBe(true);
  });
});

describe('model-choosing assistant', () => {
  const cands = [
    {
      id: 'openrouter/qwen3-coder',
      name: 'Qwen3 Coder',
      provider: 'openrouter',
      via: 'direct' as const,
      context: 262_144,
      capabilities: ['tools'],
      input: 0.3,
      output: 1,
    },
    {
      id: 'ollama/qwen3:8b',
      name: 'Qwen3 8B',
      provider: 'ollama',
      via: 'direct' as const,
      context: 40_960,
      capabilities: ['tools', 'reasoning'],
      input: 0,
      output: 0,
    },
    {
      id: 'anthropic/opus',
      name: 'Opus',
      provider: 'anthropic',
      via: 'direct' as const,
      context: 200_000,
      capabilities: ['tools', 'reasoning'],
      input: 15,
      output: 75,
    },
    {
      id: 'ollama/tiny',
      name: 'Tiny',
      provider: 'ollama',
      via: 'direct' as const,
      context: 8_000,
      capabilities: [],
      input: 0,
      output: 0,
    },
  ];
  it('guesses the job and recommends across places, deterministically', () => {
    expect(guessKind('refactor this python repo')).toBe('coding');
    const a = advise(
      {
        describe: 'an agent that calls tools',
        kind: null,
        budget: 'low',
        privacy: 'any',
        speed: 'any',
        explain: false,
      },
      cands,
      null,
    );
    expect(a.kind).toBe('agent_tools');
    expect(a.options.map((o) => o.model_id)).not.toContain('ollama/tiny');
    expect(new Set(a.options.map((o) => o.where)).size).toBe(a.options.length);
    expect(a.options.find((o) => o.where === 'openrouter')?.preset).toBe('recommended');
    expect(
      advise(
        { describe: '', kind: 'agent_tools', budget: 'low', privacy: 'any', speed: 'any', explain: false },
        cands,
        null,
      ),
    ).toEqual(a);
  });
  it('local only keeps local and rented models', () => {
    const a = advise(
      { describe: '', kind: 'chat', budget: 'medium', privacy: 'local_only', speed: 'any', explain: false },
      cands,
      null,
    );
    expect(a.options.every((o) => o.where === 'local' || o.where === 'runpod')).toBe(true);
  });
});

describe('quantization estimates', () => {
  it('memory and VRAM fit', () => {
    expect(memoryEstimateGb(32, 16, 8_192)).toBeGreaterThan(70);
    expect(memoryEstimateGb(32, 4.25, 8_192)).toBeLessThan(20);
    expect(vramFit(memoryEstimateGb(32, 4.25), 24)).toBe('fits');
    expect(vramFit(memoryEstimateGb(32, 16), 48)).toBe('no');
    expect(vramFit(23, 24)).toBe('tight');
  });
  it('vLLM choice becomes the bootstrap environment', () => {
    expect(vllmEnv({ model: 'Qwen/Qwen3-32B-AWQ', quantization: 'awq', max_model_len: 32768 })).toEqual({
      ANCILE_MODEL: 'Qwen/Qwen3-32B-AWQ',
      ANCILE_VLLM_ARGS: '--quantization awq --max-model-len 32768',
    });
    expect(vllmEnv({ model: 'Qwen/Qwen3-8B', quantization: 'original' })).toEqual({
      ANCILE_MODEL: 'Qwen/Qwen3-8B',
    });
  });
});
