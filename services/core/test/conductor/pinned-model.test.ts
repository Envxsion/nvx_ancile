/**
 * A pinned model falls back only to a model no dearer than it ("same price or
 * cheaper", DESIGN.md §7.2); every change of answering model leaves a seam on
 * the message; a stopped turn still counts what the provider was sent; an
 * answer cut off at the length limit says so.
 */
import type { Message, ModelConfig, ThreadPath } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeModel } from '../gateway/fake-provider';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const priced = (m: ModelConfig, input: number, output: number): ModelConfig => ({
  ...m,
  price: { input_per_mtok: input, output_per_mtok: output },
});
const pin = priced(fakeModel('pin', 'fail:500'), 0.1, 0.4);
const cheap = priced(fakeModel('cheap', 'say:from the cheap one'), 0.05, 0.2);
const dear = priced(fakeModel('dear', 'say:from the dear one'), 3, 15);

async function lastAssistant(threadId: string): Promise<Message> {
  const path = (await h.call<ThreadPath>('GET', `/threads/${threadId}/path`)).body;
  return path.messages.at(-1) as Message;
}

describe('a pinned model that fails', () => {
  it('falls back to a cheaper model and the message says who answered and why', async () => {
    h = await harness({
      models: [pin, cheap, dear],
      taskClasses: { 'chat.default': [dear.id, cheap.id] },
      offline: false,
    });
    const t = await h.newThread();
    const sent = await h.send(t, 'hello', { model: pin.id });
    await h.settle(sent.run_id);
    const m = await lastAssistant(t);
    expect(m.status).toBe('complete');
    expect(m.model_id).toBe(cheap.id);
    expect(m.parts.find((p) => p.type === 'seam')).toMatchObject({
      kind: 'answered_by',
      from_model: pin.id,
      to_model: cheap.id,
      reason: 'transient',
    });
    expect(m.parts.map((p) => p.type)).toEqual(['seam', 'text']);
  });

  it('never becomes a dearer model: the turn stops with choices instead', async () => {
    h = await harness({ models: [pin, dear], taskClasses: { 'chat.default': [dear.id] }, offline: false });
    const t = await h.newThread();
    const sent = await h.send(t, 'hello', { model: pin.id });
    await h.settle(sent.run_id);
    const m = await lastAssistant(t);
    expect(m.status).toBe('error');
    expect(m.model_id).toBeNull();
    const error = (m.provenance as { error: { code: string; options: { model_id: string }[] } }).error;
    expect(error.code).toBe('model.pinned_unavailable');
    expect(error.options.map((o) => o.model_id)).toEqual([dear.id]);
    // The dearer model was never asked.
    const evs = await h.eventsOf(sent.run_id);
    expect(evs.some((e) => e.type === 'model' && e.model_id === dear.id)).toBe(false);
    const ev = evs.find((e) => e.type === 'error');
    expect(ev).toMatchObject({ code: 'model.pinned_unavailable' });
  });

  it('retrying with the dearer model, chosen on the error, answers', async () => {
    h = await harness({ models: [pin, dear], taskClasses: { 'chat.default': [dear.id] }, offline: false });
    const t = await h.newThread();
    const sent = await h.send(t, 'hello', { model: pin.id });
    await h.settle(sent.run_id);
    const again = await h.call<{ run_id: string }>(
      'POST',
      `/messages/${sent.assistant_message_id}/regenerate`,
      {
        model: dear.id,
      },
    );
    await h.settle(again.body.run_id);
    const m = await lastAssistant(t);
    expect(m.status).toBe('complete');
    expect(m.model_id).toBe(dear.id);
  });
});

describe('an unpinned turn that falls back', () => {
  it('keeps its chain and still leaves the seam on the message', async () => {
    h = await harness({
      models: [pin, dear],
      taskClasses: { 'chat.default': [pin.id, dear.id] },
      offline: false,
    });
    const t = await h.newThread();
    const sent = await h.send(t, 'hello');
    await h.settle(sent.run_id);
    const m = await lastAssistant(t);
    expect(m.model_id).toBe(dear.id);
    expect(m.parts.find((p) => p.type === 'seam')).toMatchObject({
      kind: 'answered_by',
      from_model: pin.id,
      to_model: dear.id,
    });
  });
});

describe('a turn stopped mid-stream', () => {
  it('counts an estimate of what the provider was sent, marked as one', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, '/slow alpha beta gamma delta epsilon zeta eta theta');
    for (let i = 0; i < 100 && h.text(await h.eventsOf(sent.run_id)).length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    await h.call('POST', `/messages/${sent.assistant_message_id}/stop`);
    await h.settle(sent.run_id);
    const m = await lastAssistant(t);
    expect(m.status).toBe('stopped');
    expect(m.usage?.estimated).toBe(true);
    expect(m.usage?.input_tokens).toBeGreaterThan(0);
    expect(m.usage?.output_tokens).toBeGreaterThan(0);
  });

  it('a finished turn is not marked as an estimate', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, '/say done');
    await h.settle(sent.run_id);
    const m = await lastAssistant(t);
    expect(m.usage?.estimated).toBeUndefined();
  });
});

describe('an answer cut off at the length limit', () => {
  it('records that it was cut off', async () => {
    const long = fakeModel('long', 'length:The answer begins and then');
    h = await harness({ models: [long], taskClasses: { 'chat.default': [long.id] }, offline: false });
    const t = await h.newThread();
    const sent = await h.send(t, 'write a lot');
    await h.settle(sent.run_id);
    const m = await lastAssistant(t);
    expect(m.status).toBe('complete');
    expect(m.provenance).toMatchObject({ stop: 'length', cut_off: true });
  });
});
