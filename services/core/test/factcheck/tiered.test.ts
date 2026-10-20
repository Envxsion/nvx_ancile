/**
 * One claim, start to finish (TR3, SI1): the tier it is checked at, going up a tier at most twice, an
 * obvious claim judged by a tiny model, mission-critical mode's two checkers or its stop-and-ask, and
 * the verdict cache answering a repeat.
 */
import type { ModelConfig, ModelTier } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { MemoryVerdictCacheStore, VerdictCache } from '../../src/factcheck/cache';
import { needsChoice } from '../../src/factcheck/critical';
import { type CheckDeps, checkClaim, criticalCheckers, NeedsChoice } from '../../src/factcheck/steps';
import { triageClaim } from '../../src/factcheck/triage';
import type { Gateway } from '../../src/gateway/gateway';
import { resolveWant } from '../../src/gateway/tiers';

const tiers: Record<string, ModelTier> = {};
const model = (id: string, tier: ModelTier, family: string, price = 1): ModelConfig => {
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
    price: { input_per_mtok: price, output_per_mtok: price },
    enabled: true,
  };
};

const nano = model('openai/nano', 'tiny', 'openai', 0.1);
const haiku = model('anthropic/haiku', 'fast', 'anthropic', 0.5);
const sonnet = model('anthropic/sonnet', 'balanced', 'anthropic', 3);
const sol = model('openai/sol', 'balanced', 'openai', 2);
const opus = model('anthropic/opus', 'best', 'anthropic', 15);

/** A registry that routes by need over a fixed ready list, and a gateway that answers from a script. */
function rig(
  ready: ModelConfig[],
  script: Record<string, { stance: string; confidence?: number }[]>,
  cache?: VerdictCache,
) {
  const asked: string[] = [];
  const queue = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const tierOf = (m: ModelConfig) => tiers[m.id] ?? 'fast';
  const registry = {
    resolveWant: (want: never, ctx: object) => resolveWant(want, ready, { ...ctx, tierOf }),
    readyChat: () => ready,
    tierOf,
    get: (id: string) => ready.find((m) => m.id === id),
  };
  const gateway = {
    async *stream(chain: ModelConfig[]) {
      const m = chain[0] as ModelConfig;
      asked.push(m.id);
      const next = queue[m.id]?.shift() ?? { stance: 'insufficient' };
      yield { type: 'model', modelId: m.id };
      yield {
        type: 'chunk',
        chunk: {
          type: 'text',
          delta: JSON.stringify({ evidence: [], rationale: `${m.id} says so`, ...next }),
        },
      };
    },
  } as unknown as Gateway;
  const deps = { gateway, registry, promptsDir: '/none', cache } as unknown as CheckDeps;
  return { deps, asked, registry };
}

const evidence = [
  {
    kind: 'chunk' as const,
    ref: 'c1',
    source_id: 's1',
    source_title: 'Manual',
    page: 1,
    char_start: 0,
    char_end: 10,
    quote: 'The pump failed after 14 hours.',
    stance: 'neutral' as const,
    score: 0.9,
    origin: 'source' as const,
    text: 'The pump failed after 14 hours of use.',
  },
];

const input = (claim: string, extra: Record<string, unknown> = {}) => ({
  claim,
  evidence,
  triage: triageClaim(claim, { critical: false }),
  critical: false,
  generatorFamily: 'anthropic',
  generatorModelId: 'anthropic/sonnet',
  notebookId: 'nb1',
  sharing: false,
  ...extra,
});
const signal = new AbortController().signal;

describe('the tier a claim is checked at', () => {
  it('asks a tiny model about an obvious claim no source covers, and calls it common knowledge', async () => {
    const r = rig([nano, haiku, sonnet, opus], {
      'openai/nano': [{ stance: 'supported', confidence: 0.95 }],
    });
    const out = await checkClaim(r.deps, { ...input('The sky is blue.'), evidence: [] }, signal);
    expect(r.asked).toEqual(['openai/nano']);
    expect(out).toMatchObject({
      verdict: 'supported',
      tier: 'tiny',
      general: true,
      escalatedFrom: null,
      cached: null,
    });
  });

  it('asks nothing for a claim that is not obvious and has no evidence', async () => {
    const r = rig([nano, sonnet], {});
    const out = await checkClaim(
      r.deps,
      { ...input('Paris is the capital of France.'), evidence: [] },
      signal,
    );
    expect(r.asked).toEqual([]);
    expect(out).toMatchObject({ verdict: 'insufficient', modelId: '' });
  });

  it('checks a number against its source at standard tier, from another family', async () => {
    const r = rig([nano, haiku, sonnet, sol, opus], {
      'openai/sol': [{ stance: 'supported', confidence: 0.9 }],
    });
    const out = await checkClaim(r.deps, input('The pump failed after 14 hours.'), signal);
    expect(r.asked).toEqual(['openai/sol']);
    expect(out).toMatchObject({ verdict: 'supported', tier: 'balanced', escalatedFrom: null, degraded: [] });
  });
});

describe('going up a tier', () => {
  it('sends a contradiction from a small model to a standard one, and reports where it started', async () => {
    const r = rig([haiku, sol], {
      'anthropic/haiku': [{ stance: 'contradicted', confidence: 0.8 }],
      'openai/sol': [{ stance: 'supported', confidence: 0.9 }],
    });
    const out = await checkClaim(
      r.deps,
      { ...input('Owls hunt near Paris at night.'), generatorFamily: 'google' },
      signal,
    );
    expect(r.asked).toEqual(['anthropic/haiku', 'openai/sol']);
    expect(out).toMatchObject({ verdict: 'supported', tier: 'balanced', escalatedFrom: 'fast' });
  });

  it('goes up at most twice', async () => {
    const r = rig([nano, haiku, sonnet, opus], {
      'openai/nano': [{ stance: 'contradicted' }],
      'anthropic/haiku': [{ stance: 'contradicted' }],
      'anthropic/sonnet': [{ stance: 'contradicted' }],
      'anthropic/opus': [{ stance: 'supported' }],
    });
    const out = await checkClaim(
      r.deps,
      { ...input('The sky is blue.'), evidence: [], generatorFamily: 'google' },
      signal,
    );
    expect(r.asked).toEqual(['openai/nano', 'anthropic/haiku', 'anthropic/sonnet']);
    expect(out).toMatchObject({ verdict: 'contradicted', tier: 'balanced', escalatedFrom: 'tiny' });
  });

  it('stays where it is when no stronger model is ready', async () => {
    const r = rig([haiku], { 'anthropic/haiku': [{ stance: 'contradicted', confidence: 0.3 }] });
    const out = await checkClaim(r.deps, input('Owls hunt near Paris at night.'), signal);
    expect(r.asked).toEqual(['anthropic/haiku']);
    expect(out.escalatedFrom).toBeNull();
  });

  it('says so when only the writer family could check, and when the tier was not there', async () => {
    const r = rig([haiku], { 'anthropic/haiku': [{ stance: 'supported', confidence: 0.9 }] });
    const out = await checkClaim(r.deps, input('The pump failed after 14 hours.'), signal);
    expect(out.verdict).toBe('supported');
    expect(out.degraded.join(' ')).toMatch(/No standard model is ready/);
  });
});

describe('mission-critical mode', () => {
  const critical = (claim: string, extra: Record<string, unknown> = {}) => ({
    ...input(claim, extra),
    critical: true,
    triage: triageClaim(claim, { critical: true }),
  });

  it('uses two standard-or-better checkers of other families, and the claim holds only if both agree', async () => {
    const r = rig([nano, sonnet, sol, opus], {
      'openai/sol': [{ stance: 'supported' }],
      'anthropic/opus': [{ stance: 'contradicted' }],
    });
    const out = await checkClaim(
      r.deps,
      { ...critical('The pump failed after 14 hours.'), generatorFamily: 'google' },
      signal,
    );
    expect(r.asked.sort()).toEqual(['anthropic/opus', 'openai/sol'].sort());
    expect(out.verdict).toBe('contradicted');
    expect(out.verdicts).toHaveLength(2);
    expect(r.asked).not.toContain('openai/nano');
  });

  it('stops and asks when two independent checkers are not both ready', async () => {
    const r = rig([nano, haiku, sonnet], {});
    expect(
      criticalCheckers(r.registry as never, {
        generatorFamily: 'anthropic',
        generatorModelId: 'anthropic/sonnet',
      }),
    ).toBeNull();
    await expect(
      checkClaim(r.deps, critical('The pump failed after 14 hours.'), signal),
    ).rejects.toBeInstanceOf(NeedsChoice);
    expect(r.asked).toEqual([]);
  });

  it('lists every ready chat model for the choice, the same provider included', () => {
    const r = rig([nano, haiku, sonnet, opus], {});
    const choice = needsChoice(r.registry as never, {
      generatorFamily: 'anthropic',
      generatorModelId: 'anthropic/sonnet',
    }).needs_choice;
    expect(choice.code).toBe('factcheck.needs_choice');
    expect(choice.models.map((m) => m.id)).toEqual([
      'anthropic/opus',
      'anthropic/sonnet',
      'anthropic/haiku',
      'openai/nano',
    ]);
    expect(choice.models.find((m) => m.id === 'anthropic/opus')).toMatchObject({
      same_family_as_writer: true,
      suitable: true,
    });
    expect(choice.models.find((m) => m.id === 'openai/nano')?.suitable).toBe(false);
    // The writer never checks itself, so Opus is the first suggestion.
    expect(choice.suggested).toEqual(['anthropic/opus']);
  });

  it('runs exactly the models the person chose: Sonnet writes, Opus checks', async () => {
    const r = rig([nano, haiku, sonnet, opus], {
      'anthropic/opus': [{ stance: 'supported', confidence: 0.9 }],
    });
    const out = await checkClaim(
      r.deps,
      { ...critical('The pump failed after 14 hours.'), chosen: [opus] },
      signal,
    );
    expect(r.asked).toEqual(['anthropic/opus']);
    expect(out).toMatchObject({ verdict: 'supported', tier: 'best' });
    expect(out.degraded).toEqual([]);
  });

  it('allows a choice below standard, and says so', async () => {
    const r = rig([haiku], { 'anthropic/haiku': [{ stance: 'supported' }] });
    const out = await checkClaim(
      r.deps,
      { ...critical('The pump failed after 14 hours.'), chosen: [haiku] },
      signal,
    );
    expect(out.degraded.join(' ')).toMatch(/below standard tier; you chose it/);
  });
});

describe('the verdict cache', () => {
  it('answers a repeat without asking a model, says when and by whom, and rechecks on request', async () => {
    const cache = new VerdictCache(new MemoryVerdictCacheStore());
    const r = rig([haiku, sol], { 'openai/sol': [{ stance: 'supported' }, { stance: 'supported' }] }, cache);
    const first = await checkClaim(r.deps, input('The pump failed after 14 hours.'), signal);
    expect(first.cached).toBeNull();
    const again = await checkClaim(r.deps, input('the pump failed after 14 hours'), signal);
    expect(again.cached).toMatchObject({ model_id: 'openai/sol', scope: 'notebook' });
    expect(again.verdict).toBe('supported');
    expect(r.asked).toEqual(['openai/sol']);
    await checkClaim(r.deps, { ...input('The pump failed after 14 hours.'), again: true }, signal);
    expect(r.asked).toEqual(['openai/sol', 'openai/sol']);
  });

  it('does not reuse a verdict after the source changed', async () => {
    const cache = new VerdictCache(new MemoryVerdictCacheStore());
    const r = rig([sol], { 'openai/sol': [{ stance: 'supported' }, { stance: 'contradicted' }] }, cache);
    await checkClaim(r.deps, input('The pump failed after 14 hours.'), signal);
    const changed = [{ ...evidence[0], text: 'The pump failed after 20 hours of use.' }] as typeof evidence;
    const out = await checkClaim(
      r.deps,
      { ...input('The pump failed after 14 hours.'), evidence: changed },
      signal,
    );
    expect(out.cached).toBeNull();
    expect(r.asked).toHaveLength(2);
  });
});
