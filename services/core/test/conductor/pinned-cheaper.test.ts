/**
 * A pinned model that fails falls back to any ready model no dearer than it, not only the ones its
 * class names, cheapest suitable first (DESIGN.md §7.2). A dropped connection is asked again on the
 * same model first, and is never reported as the model being unavailable. The error's words are
 * plain: the provider's own text stays in the attempts.
 */
import type { Message, ModelConfig, ThreadPath } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeModel } from '../gateway/fake-provider';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const priced = (m: ModelConfig, input: number, output: number, extra: Partial<ModelConfig> = {}) => ({
  ...m,
  price: { input_per_mtok: input, output_per_mtok: output },
  ...extra,
});
const pin = priced(fakeModel('pin', 'fail:500'), 1, 5);
const dear = priced(fakeModel('dear', 'say:from the dear one'), 3, 15);
const tinyCheap = priced(fakeModel('tiny-cheap', 'say:from the tiny one'), 0.018, 0.05);
const midCheap = priced(fakeModel('mid-cheap', 'say:from the mid one'), 0.1, 0.3);

async function lastAssistant(threadId: string): Promise<Message> {
  const path = (await h.call<ThreadPath>('GET', `/threads/${threadId}/path`)).body;
  return path.messages.at(-1) as Message;
}

describe('a pinned model falls back across every ready model', () => {
  it('finds a cheaper model that is not in the class chain, and never asks the dearer one', async () => {
    h = await harness({
      models: [pin, dear, midCheap, tinyCheap],
      taskClasses: { 'chat.default': [dear.id] },
      offline: false,
    });
    const t = await h.newThread();
    const sent = await h.send(t, 'hello', { model: pin.id });
    await h.settle(sent.run_id);
    const m = await lastAssistant(t);
    expect(m.status).toBe('complete');
    expect([tinyCheap.id, midCheap.id]).toContain(m.model_id);
    const evs = await h.eventsOf(sent.run_id);
    expect(evs.some((e) => e.type === 'model' && e.model_id === dear.id)).toBe(false);
  });

  it('when every cheaper model fails too, the choices are the untried models and the words are plain', async () => {
    const dead = priced(fakeModel('dead', 'fail:auth'), 0.05, 0.2);
    h = await harness({
      models: [pin, dead, dear],
      taskClasses: { 'chat.default': [dear.id] },
      offline: false,
    });
    const t = await h.newThread();
    const sent = await h.send(t, 'hello', { model: pin.id });
    await h.settle(sent.run_id);
    const m = await lastAssistant(t);
    const error = (m.provenance as { error: { code: string; hint: string; options: { model_id: string }[] } })
      .error;
    expect(error.code).toBe('model.pinned_unavailable');
    expect(error.options.map((o) => o.model_id)).toEqual([dear.id]);
    expect(error.hint).not.toMatch(/upstream exploded|x-api-key/);
    expect(error.hint).toContain('cheaper models tried after it could not answer either');
    const ev = (await h.eventsOf(sent.run_id)).find((e) => e.type === 'error');
    expect(JSON.stringify(ev)).toContain('upstream exploded');
  });
});

describe('the registry names stand-ins for a pinned model', () => {
  it('lists ready models no dearer than it, same or lower tier first, then cheapest', async () => {
    h = await harness({
      models: [pin, dear, midCheap, tinyCheap],
      taskClasses: { 'chat.default': [dear.id] },
      offline: false,
    });
    const reg = h.registry;
    const order = reg.cheaperThan(reg.get(pin.id) as ModelConfig).map((m) => m.id);
    expect(order).not.toContain(dear.id);
    expect(order.indexOf(tinyCheap.id)).toBeLessThan(order.indexOf(midCheap.id));
  });

  it('leaves out a model that lacks what the turn needs', async () => {
    const blind = priced(fakeModel('blind', 'say:x'), 0.01, 0.02, { capabilities: ['tools'] });
    const sees = priced(fakeModel('sees', 'say:y'), 0.2, 0.6, { capabilities: ['tools', 'vision'] });
    h = await harness({
      models: [pin, blind, sees],
      taskClasses: { 'chat.default': [sees.id] },
      offline: false,
    });
    const reg = h.registry;
    const order = reg.cheaperThan(reg.get(pin.id) as ModelConfig, { needs: ['vision'] }).map((m) => m.id);
    expect(order).toEqual([sees.id]);
    const small = reg.cheaperThan(reg.get(pin.id) as ModelConfig, { ctxTokens: 10_000_000 });
    expect(small).toEqual([]);
  });
});

describe('a dropped connection', () => {
  it('is asked again on the same model before any fallback', async () => {
    const blippy = priced(fakeModel('blippy', 'fail:blip'), 1, 5);
    h = await harness({
      models: [blippy, tinyCheap],
      taskClasses: { 'chat.default': [tinyCheap.id] },
      offline: false,
    });
    const t = await h.newThread();
    const sent = await h.send(t, 'hello', { model: blippy.id });
    await h.settle(sent.run_id);
    const m = await lastAssistant(t);
    expect(m.status).toBe('complete');
    expect(m.model_id).toBe(blippy.id);
    expect(m.parts.some((p) => p.type === 'seam')).toBe(false);
  });

  it('is not called unavailable: the words say it was a temporary problem', async () => {
    const down = priced(fakeModel('down', 'fail:connect'), 1, 5);
    h = await harness({ models: [down, dear], taskClasses: { 'chat.default': [dear.id] }, offline: false });
    const t = await h.newThread();
    const sent = await h.send(t, 'hello', { model: down.id });
    await h.settle(sent.run_id);
    const m = await lastAssistant(t);
    const error = (m.provenance as { error: { hint: string } }).error;
    expect(error.hint).toContain('had a temporary problem');
    expect(error.hint).not.toMatch(/not available|Cannot connect/);
  });
});
