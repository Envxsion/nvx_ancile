/**
 * A helper job nobody chose a model for (Beam's fuser) gets the cheapest ready standard-tier model,
 * never the dearest one by the order of a list, and a frontier model only when nothing else can answer.
 */
import type { ModelConfig, ModelTier } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, harness } from '../support/harness';
import { fakeModel } from './fake-provider';

let h: Harness;
afterEach(async () => h?.close());

const at = (id: string, tier: ModelTier, input: number, output: number): ModelConfig => ({
  ...fakeModel(id, 'echo'),
  tier,
  price: { input_per_mtok: input, output_per_mtok: output },
});

describe('the cheapest standard model', () => {
  it('is not the first listed or the dearest', async () => {
    const fable = at('fable', 'best', 10, 50);
    const sonnet = at('sonnet', 'balanced', 2, 10);
    const gemma = at('gemma', 'balanced', 0.05, 0.15);
    const oss = at('oss', 'tiny', 0.018, 0.05);
    h = await harness({ models: [fable, sonnet, gemma, oss], offline: false });
    expect(h.registry.cheapestStandard()?.id).toBe('fake/gemma');
  });

  it('falls to the cheapest small model, and takes a frontier one only when it is the only one', async () => {
    const fable = at('fable', 'best', 10, 50);
    const oss = at('oss', 'tiny', 0.018, 0.05);
    const fast = at('fast', 'fast', 0.3, 1);
    h = await harness({ models: [fable, oss, fast], offline: false });
    expect(h.registry.cheapestStandard()?.id).toBe('fake/fast');
    await h.close();
    h = await harness({ models: [fable], offline: false });
    expect(h.registry.cheapestStandard()?.id).toBe('fake/fable');
  });

  it('respects what the caller allows', async () => {
    const sonnet = at('sonnet', 'balanced', 2, 10);
    const gemma = at('gemma', 'balanced', 0.05, 0.15);
    h = await harness({ models: [sonnet, gemma], offline: false });
    expect(h.registry.cheapestStandard((m) => m.id !== 'fake/gemma')?.id).toBe('fake/sonnet');
    expect(h.registry.cheapestStandard(() => false)).toBeUndefined();
  });
});
