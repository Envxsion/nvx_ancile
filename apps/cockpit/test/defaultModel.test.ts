/**
 * ------------------------------------------------------------------
 *  Title    |  The default model is never the dearest by accident
 *  Ref      |  apps/cockpit/src/lib/defaultModel.ts · docs/models.md
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  A lineup that lists its dearest model first once made it
 *           |  the composer's model. With nothing chosen, the routing
 *           |  default answers; failing that, the cheapest standard
 *           |  model; never the first one listed.
 * ------------------------------------------------------------------
 */

import type { ModelTier } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { pickDefaultModel } from '../src/lib/defaultModel';
import type { ModelView } from '../src/lib/types';

const m = (id: string, tier: ModelTier, out: number, p: Partial<ModelView> = {}): ModelView => ({
  id,
  name: id,
  provider: 'x',
  hue: 'chalk',
  via: 'direct',
  contextWindow: 100_000,
  status: 'ready',
  chat: true,
  billing: { kind: 'key', payer: 'x' },
  price: { in: out / 5, out },
  tier,
  ...p,
});

const fable = m('anthropic/fable', 'best', 50);
const sonnet = m('anthropic/sonnet', 'balanced', 10);
const gemma = m('or/gemma-4', 'balanced', 0.4);
const small = m('or/gpt-oss-20b', 'tiny', 0.05);

describe('the model chosen when you chose none', () => {
  it('is the routing default when it can answer, whatever the list order', () => {
    expect(pickDefaultModel([fable, sonnet, gemma, small], 'anthropic/sonnet')?.id).toBe('anthropic/sonnet');
  });

  it('is the cheapest standard model, not the first listed, when routing names none', () => {
    expect(pickDefaultModel([fable, sonnet, gemma, small])?.id).toBe('or/gemma-4');
    expect(pickDefaultModel([fable, sonnet, gemma, small], 'missing/model')?.id).toBe('or/gemma-4');
  });

  it('skips a routing default that cannot answer', () => {
    const off = m('anthropic/sonnet', 'balanced', 10, { status: 'needs_key' });
    expect(pickDefaultModel([fable, off, gemma], 'anthropic/sonnet')?.id).toBe('or/gemma-4');
  });

  it('prefers a small model to a frontier one when no standard model is ready', () => {
    expect(pickDefaultModel([fable, small])?.id).toBe('or/gpt-oss-20b');
  });

  it('takes the frontier model only when it is the only one', () => {
    expect(pickDefaultModel([fable])?.id).toBe('anthropic/fable');
  });

  it('never picks a GPU-node model for you, nor a test model while a real one is ready', () => {
    const node = m('node/llama', 'balanced', 0, { via: 'controller' });
    const test = m('fake/echo', 'tiny', 0, { offline: true });
    expect(pickDefaultModel([node, test, fable])?.id).toBe('anthropic/fable');
  });

  it('leaves a plan model for last', () => {
    const plan = m('claude-code/sonnet', 'balanced', 0, { billing: { kind: 'plan', payer: 'max' } });
    expect(pickDefaultModel([plan, sonnet])?.id).toBe('anthropic/sonnet');
    expect(pickDefaultModel([plan])?.id).toBe('claude-code/sonnet');
  });

  it('with no tiers known, takes the cheapest rather than the first', () => {
    const a = m('a', 'balanced', 40);
    const b = m('b', 'balanced', 1);
    const { tier: _a, ...plainA } = a;
    const { tier: _b, ...plainB } = b;
    expect(pickDefaultModel([plainA, plainB])?.id).toBe('b');
  });

  it('is undefined when nothing can answer', () => {
    expect(pickDefaultModel([m('a', 'balanced', 1, { status: 'disabled' })])).toBeUndefined();
  });
});
