/**
 * Tiers and routing by need (TR1, TR2): every model gets a tier from its line, its size or its
 * price, and a need finds the best ready model in any provider, widening in a fixed order rather
 * than failing.
 */
import { AncileError, type ModelConfig, type ModelTier, type Want } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import {
  assignTier,
  defaultWantFor,
  resolveWant,
  sizeBillions,
  tierDown,
  tierFromPrice,
  tierUp,
} from '../../src/gateway/tiers';

const mk = (
  provider: string,
  provider_model: string,
  extra: Partial<ModelConfig> = {},
  out = 0,
): ModelConfig => ({
  id: `${provider}/${provider_model}`,
  provider,
  provider_model,
  display_name: provider_model,
  via: 'direct',
  family: provider,
  context_window: 100_000,
  max_output: 8_000,
  capabilities: [],
  price: { input_per_mtok: out / 4, output_per_mtok: out },
  enabled: true,
  ...extra,
});

describe('which tier a model is (TR2)', () => {
  const table: [string, string, ModelTier, string, number?][] = [
    // Direct providers, by line.
    ['anthropic', 'claude-opus-5-5', 'best', 'line'],
    ['anthropic', 'claude-sonnet-5-5', 'balanced', 'line'],
    ['anthropic', 'claude-haiku-5-5', 'fast', 'line'],
    ['anthropic', 'claude-haiku-4-5-20251001', 'fast', 'line'],
    ['openai', 'gpt-5.5', 'best', 'line'],
    ['openai', 'gpt-5.6-sol', 'balanced', 'line'],
    ['openai', 'gpt-5.6-luna', 'fast', 'line'],
    ['openai', 'gpt-5-mini', 'balanced', 'line'],
    ['openai', 'gpt-5-nano', 'tiny', 'line'],
    ['google', 'gemini-3.1-pro-preview', 'best', 'line'],
    ['google', 'gemini-3.8-flash', 'balanced', 'line'],
    ['google', 'gemini-3.5-flash-lite', 'tiny', 'line'],
    ['mistral', 'mistral-large-latest', 'best', 'line'],
    ['mistral', 'mistral-small-latest', 'fast', 'line'],
    ['deepseek', 'deepseek-v4-pro', 'best', 'line'],
    ['deepseek', 'deepseek-flash', 'fast', 'line'],
    // Claude Code names its line.
    ['claude_code', 'sonnet', 'balanced', 'line'],
    ['claude_code', 'haiku', 'fast', 'line'],
    ['claude_code', 'opus', 'best', 'line'],
    // OpenRouter: vendor/name, read through the vendor's rules.
    ['openrouter', 'anthropic/claude-sonnet-4.5', 'balanced', 'line'],
    ['openrouter', 'anthropic/claude-3.5-haiku', 'fast', 'line'],
    ['openrouter', 'openai/gpt-5-mini', 'balanced', 'line'],
    ['openrouter', 'google/gemini-2.5-flash-lite', 'tiny', 'line'],
    ['openrouter', 'google/gemini-2.5-pro', 'best', 'line'],
    ['openrouter', 'mistralai/mistral-large-latest', 'best', 'line'],
    ['openrouter', 'qwen/qwen3.8-max:free', 'best', 'line'],
    // No line: the size in the name.
    ['openrouter', 'meta-llama/llama-3.3-70b-instruct', 'balanced', 'size'],
    ['openrouter', 'meta-llama/llama-3.1-8b-instruct', 'tiny', 'size'],
    ['openrouter', 'qwen/qwen3-30b-a3b', 'tiny', 'size'], // a mixture: its 3B active counts
    ['openrouter', 'qwen/qwen3-235b-a22b', 'fast', 'size'],
    ['ollama', 'llama3.2:3b', 'tiny', 'size'],
    ['ollama', 'qwen3:14b', 'fast', 'size'],
    ['ollama', 'gemma3:27b', 'fast', 'size'],
    ['ollama', 'llama3.3:70b', 'balanced', 'size'],
    ['ollama', 'deepseek-r1:671b', 'balanced', 'size'],
    ['ollama', 'mixtral:8x7b', 'balanced', 'size'],
    ['ollama', 'smollm2:360m', 'tiny', 'size'],
    ['ollama', 'phi3:mini', 'tiny', 'size'],
    // No line, no size: the price.
    ['together', 'acme-ultra', 'best', 'price', 20],
    ['together', 'acme-pro', 'balanced', 'price', 3],
    ['together', 'acme-cheap', 'fast', 'price', 0.5],
    ['together', 'acme-cheapest', 'tiny', 'price', 0.1],
    // Nothing to go on: small, never frontier.
    ['ollama', 'mystery-model', 'fast', 'unknown'],
  ];
  it.each(table)('%s %s is %s (by %s)', (provider, id, tier, source, out) => {
    expect(assignTier(mk(provider, id, {}, out ?? 0))).toEqual({ tier, source });
  });

  it('lets you pin a tier, in models.yaml or in Admin → Models', () => {
    expect(assignTier(mk('anthropic', 'claude-opus-5-5', { tier: 'balanced' }))).toEqual({
      tier: 'balanced',
      source: 'override',
    });
    expect(assignTier(mk('anthropic', 'claude-opus-5-5'), 'tiny')).toEqual({
      tier: 'tiny',
      source: 'override',
    });
  });

  it('reads sizes and prices on their own', () => {
    expect(sizeBillions('qwen3-30b-a3b')).toEqual({ total: 30, active: 3 });
    expect(sizeBillions('mixtral-8x7b')).toEqual({ total: 56, active: 56 });
    expect(sizeBillions('gpt-5.5')).toBeNull();
    expect(tierFromPrice(mk('x', 'y', {}, 0))).toBeNull();
    expect(tierUp('best')).toBe('best');
    expect(tierDown('tiny')).toBe('tiny');
    expect(tierUp('tiny')).toBe('fast');
  });
});

describe('routing by need (TR1)', () => {
  const T: Record<string, ModelTier> = {};
  const m = (id: string, tier: ModelTier, family: string, extra: Partial<ModelConfig> = {}, out = 1) => {
    const x = mk(family, id, { family, ...extra }, out);
    T[x.id] = tier;
    return x;
  };
  const tierOf = (x: ModelConfig) => T[x.id] ?? 'fast';
  const want = (w: Partial<Want> & Pick<Want, 'tier'>): Want => ({ needs: [], ...w });

  const opus = m('opus', 'best', 'anthropic', {}, 25);
  const sonnet = m('sonnet', 'balanced', 'anthropic', {}, 15);
  const sol = m('sol', 'balanced', 'openai', {}, 10);
  const flash = m('flash', 'balanced', 'google', {}, 2);
  const haiku = m('haiku', 'fast', 'anthropic', {}, 5);
  const nano = m('nano', 'tiny', 'openai', {}, 0.4);

  it('picks the cheapest model of the wanted tier, from any company', () => {
    const r = resolveWant(want({ tier: 'balanced' }), [opus, sonnet, sol, flash, haiku], { tierOf });
    expect(r.chain[0]?.id).toBe(flash.id);
    expect(r.tier).toBe('balanced');
    expect(r.degraded).toEqual([]);
  });

  it('puts another family first when the writer is known', () => {
    const r = resolveWant(want({ tier: 'balanced', distinct_family: 'generator' }), [sonnet, sol, flash], {
      tierOf,
      generatorFamily: 'anthropic',
    });
    expect(r.chain.map((x) => x.id)).toEqual([flash.id, sol.id, sonnet.id]);
    expect(r.degraded).toEqual([]);
  });

  it('with only the writer family at the tier, completes and says so', () => {
    const r = resolveWant(want({ tier: 'balanced', distinct_family: 'generator' }), [sonnet, haiku, nano], {
      tierOf,
      generatorFamily: 'anthropic',
    });
    expect(r.chain[0]?.id).toBe(sonnet.id);
    expect(r.degraded.join(' ')).toMatch(/another family/);
    expect(r.degraded.join(' ')).toMatch(/writer's family/);
  });

  it('widens one tier before taking anything: up first, then down, then any', () => {
    const r = resolveWant(want({ tier: 'balanced' }), [opus, haiku, nano], { tierOf });
    expect(r.chain.map((x) => x.id)).toEqual([opus.id, haiku.id, nano.id]);
    expect(r.degraded[0]).toMatch(/No standard model is ready, so opus \(frontier, above/);
    const down = resolveWant(want({ tier: 'balanced' }), [nano, haiku], { tierOf });
    expect(down.chain[0]?.id).toBe(haiku.id);
    expect(down.degraded[0]).toMatch(/small, below/);
  });

  it('never goes below a floor', () => {
    const r = resolveWant(want({ tier: 'balanced', floor: 'balanced' }), [haiku, nano], { tierOf });
    expect(r.chain).toEqual([]);
    expect(r.unmet).toBe('floor');
    const ok = resolveWant(want({ tier: 'fast', floor: 'tiny' }), [nano], { tierOf });
    expect(ok.chain[0]?.id).toBe(nano.id);
  });

  it('filters by what the task needs, and says when nothing has it', () => {
    const seer = m('seer', 'fast', 'google', { capabilities: ['vision'] }, 3);
    const r = resolveWant(want({ tier: 'balanced', needs: ['vision'] }), [sonnet, seer], { tierOf });
    expect(r.chain[0]?.id).toBe(seer.id);
    const none = resolveWant(want({ tier: 'balanced', needs: ['vision'] }), [sonnet], { tierOf });
    expect(none.chain[0]?.id).toBe(sonnet.id);
    expect(none.degraded[0]).toMatch(/vision/);
    const big = resolveWant(want({ tier: 'balanced', ctx_tokens: 500_000 }), [sonnet], { tierOf });
    expect(big.degraded[0]).toMatch(/500000-token window/);
  });

  it('puts pins first, and plan engines after paid keys at the same tier', () => {
    const plan = m('plan', 'balanced', 'claude_code', { provider: 'claude_code' }, 0);
    const r = resolveWant(want({ tier: 'balanced' }), [plan, sonnet], { tierOf });
    expect(r.chain.map((x) => x.id)).toEqual([sonnet.id, plan.id]);
    const pinned = resolveWant(want({ tier: 'balanced' }), [plan, sonnet, sol], { tierOf, pins: [sol] });
    expect(pinned.chain[0]?.id).toBe(sol.id);
    expect(pinned.degraded).toEqual([]);
  });

  it('honours the payment-source hook (PS1), then price', () => {
    const r = resolveWant(want({ tier: 'balanced' }), [sonnet, sol], {
      tierOf,
      sourceRank: (x) => (x.id === sonnet.id ? 0 : 1),
    });
    expect(r.chain[0]?.id).toBe(sonnet.id);
  });

  it('keeps out what the scope keeps out, and what is excluded', () => {
    const r = resolveWant(want({ tier: 'balanced' }), [sonnet, sol], {
      tierOf,
      allow: (x) => (x.id === sol.id ? 'Nothing may leave this machine here' : null),
      exclude: new Set(['nope']),
    });
    expect(r.chain.map((x) => x.id)).toEqual([sonnet.id]);
    const all = resolveWant(want({ tier: 'balanced' }), [sol], { tierOf, allow: () => 'Private notebook' });
    expect(all.unmet).toBe('scope');
    expect(all.refused).toEqual(['Private notebook']);
  });

  it('fails only when no chat model is ready, and says to add a key', () => {
    let err: unknown;
    try {
      resolveWant(want({ tier: 'balanced' }), [], { tierOf });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AncileError);
    expect((err as AncileError).code).toBe('routing.no_chat_model');
    expect((err as AncileError).hint).toMatch(/Add a key in Settings → Keys/);
  });

  it('has defaults for the helper classes, and none for chat', () => {
    expect(defaultWantFor('utility')).toMatchObject({ tier: 'fast', floor: 'tiny' });
    expect(defaultWantFor('factcheck.verify')).toMatchObject({
      tier: 'balanced',
      distinct_family: 'generator',
    });
    expect(defaultWantFor('chat.default')).toBeNull();
  });
});
