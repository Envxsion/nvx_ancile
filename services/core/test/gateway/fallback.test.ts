import type { ModelConfig } from '@nvx/contracts';
import { CircuitBreaker, instantClock } from '@nvx/resilience';
import { describe, expect, it } from 'vitest';
import { ChainFailedError, CONTINUE_INSTRUCTION, Gateway } from '../../src/gateway/gateway';
import { cannotBeRefusal, looksLikeRefusal } from '../../src/gateway/refusal';
import { NoRouteError, resolveChain } from '../../src/gateway/router';
import type { GatewayEvent } from '../../src/gateway/types';
import { FakeProvider, fakeModel } from './fake-provider';

const LONG =
  'The quick brown fox jumps over the lazy dog and keeps running across the field until the sun goes down behind the hills, where it finally rests. '.repeat(
    2,
  );

async function collect(gw: Gateway, chain: ModelConfig[]) {
  const events: GatewayEvent[] = [];
  let error: unknown;
  try {
    for await (const e of gw.stream(
      chain,
      { messages: [{ role: 'user', content: 'hello there' }] },
      new AbortController().signal,
    ))
      events.push(e);
  } catch (err) {
    error = err;
  }
  const text = events
    .map((e) => (e.type === 'chunk' && e.chunk.type === 'text' ? e.chunk.delta : ''))
    .join('');
  return {
    events,
    text,
    error,
    kinds: events
      .filter((e) => e.type !== 'chunk')
      .map((e) => (e.type === 'fallback' ? `fallback:${e.reason}` : e.type)),
  };
}

const gateway = (p = new FakeProvider()) => ({
  p,
  gw: new Gateway({ client: p, breaker: new CircuitBreaker({ clock: instantClock() }) }),
});

describe('Gateway fallback (DESIGN.md §7.1–7.2)', () => {
  it('streams from the first model when it works', async () => {
    const { gw } = gateway();
    const r = await collect(gw, [fakeModel('a', 'echo'), fakeModel('b', 'say:never')]);
    expect(r.text).toBe('hello there');
    expect(r.kinds).toEqual(['model']);
  });

  it.each([
    ['fail:500', 'transient'],
    ['fail:timeout', 'transient'],
    ['fail:auth', 'permanent'],
    ['refusal', 'refusal'],
    ['filter', 'refusal'],
  ])('falls back on %s as %s, invisibly to the reader', async (behaviour, cls) => {
    const { gw } = gateway();
    const r = await collect(gw, [fakeModel('a', behaviour), fakeModel('b', 'say:from b')]);
    expect(r.text).toBe('from b');
    expect(r.kinds).toEqual([`fallback:${cls}`, 'model']);
  });

  it('does not fall back on context overflow: compaction handles that', async () => {
    const { gw } = gateway();
    const r = await collect(gw, [fakeModel('a', 'overflow'), fakeModel('b', 'say:never')]);
    expect(r.error).toBeInstanceOf(ChainFailedError);
    expect((r.error as ChainFailedError).errorClass).toBe('context_overflow');
  });

  it('continues a broken stream on the next model and marks the seam', async () => {
    const { gw, p } = gateway();
    const r = await collect(gw, [fakeModel('a', `break:40:${LONG}`), fakeModel('b', 'say:and the rest.')]);
    expect(r.kinds).toEqual(['model', 'fallback:transient', 'seam', 'model']);
    expect(r.text.endsWith('and the rest.')).toBe(true);
    const cont = p.calls[1]?.req.messages ?? [];
    expect(cont.at(-1)?.content).toBe(CONTINUE_INSTRUCTION);
    expect(cont.at(-2)?.role).toBe('assistant');
  });

  it('reports every attempt when the whole chain fails', async () => {
    const { gw } = gateway();
    const r = await collect(gw, [fakeModel('a', 'fail:500'), fakeModel('b', 'refusal')]);
    expect(r.error).toBeInstanceOf(ChainFailedError);
    expect((r.error as ChainFailedError).attempts.map((a) => a.errorClass)).toEqual(['transient', 'refusal']);
  });

  it('skips a model whose circuit is open', async () => {
    const { gw, p } = gateway();
    const bad = fakeModel('a', 'fail:500');
    for (let i = 0; i < 5; i++) await collect(gw, [bad, fakeModel('b', 'say:ok')]);
    const before = p.calls.filter((c) => c.model === bad.id).length;
    const r = await collect(gw, [bad, fakeModel('b', 'say:ok')]);
    expect(p.calls.filter((c) => c.model === bad.id).length).toBe(before); // the breaker refused before the model was called
    expect(r.text).toBe('ok');
  });
});

describe('refusal detection', () => {
  it.each([
    ["I'm sorry, but I can't help with that.", true],
    ['I can’t assist with this request.', true],
    ['As an AI language model, I cannot browse.', true],
    ["I'm sorry for the confusion earlier. Here is the corrected table.", false],
    ['I cannot stress enough how useful this is.', false],
  ])('%s → %s', (text, want) => {
    expect(looksLikeRefusal(text)).toBe(want);
  });
});

describe('streaming starts early', () => {
  it.each([
    ['The pump ', true],
    ['## Pricing\n', true],
    ['Sure', false], // the first word is not finished yet
    ["I'm ", false],
    ['I ', false],
    ['Sorry, ', false],
    ['Unfortunately ', false],
    ['As ', false],
    ['Itemised costs ', true],
  ])('%j can stream now: %s', (text, want) => {
    expect(cannotBeRefusal(text)).toBe(want);
  });
});

describe('resolveChain', () => {
  const models = new Map(
    [
      fakeModel('a', 'x', 'anthropic'),
      fakeModel('b', 'x', 'openai'),
      fakeModel('c', 'x', 'anthropic'),
      { ...fakeModel('off', 'x'), enabled: false },
    ].map((m) => [m.id, m] as const),
  );
  const tc = {
    'chat.default': ['fake/a', 'fake/b'],
    'factcheck.verify': { chain: ['fake/a', 'fake/c', 'fake/b'], prefer_different_family: true },
    utility: ['fake/off', 'fake/c'],
  };

  it('puts an explicit choice first without duplicating it', () => {
    expect(
      resolveChain({ taskClass: 'chat.default', explicit: 'fake/b' }, tc, models).map((m) => m.id),
    ).toEqual(['fake/b', 'fake/a']);
  });

  it('walks up dotted task classes', () => {
    expect(resolveChain({ taskClass: 'chat.default.long' }, tc, models).map((m) => m.id)).toEqual([
      'fake/a',
      'fake/b',
    ]);
    expect(resolveChain({ taskClass: 'utility.title' }, tc, models).map((m) => m.id)).toEqual(['fake/c']);
  });

  it('keeps fact-check verifiers independent of the generator when it can', () => {
    expect(
      resolveChain({ taskClass: 'factcheck.verify', generatorFamily: 'anthropic' }, tc, models).map(
        (m) => m.id,
      ),
    ).toEqual(['fake/b', 'fake/a', 'fake/c']);
  });

  it('explains when nothing can answer', () => {
    expect(() => resolveChain({ taskClass: 'embed' }, { embed: ['fake/off'] }, models)).toThrow(NoRouteError);
  });
});

describe('Gateway: a stop ends the walk down the chain', () => {
  const chain = ['a', 'b', 'c', 'd'].map((id) => fakeModel(id, 'echo'));
  const req = { messages: [{ role: 'user' as const, content: 'hello there' }] };

  it('asks no further model once the signal is aborted, whatever the one in flight threw', async () => {
    const ctl = new AbortController();
    const asked: string[] = [];
    const client = {
      // biome-ignore lint/correctness/useYield: fails before it has anything to say
      async *stream(model: ModelConfig) {
        asked.push(model.id);
        ctl.abort(new Error('cancelled'));
        throw new Error('503 service unavailable'); // transient: normally the next model is tried
      },
    };
    const gw = new Gateway({ client, breaker: new CircuitBreaker({ clock: instantClock() }) });
    const events: GatewayEvent[] = [];
    await expect(
      (async () => {
        for await (const e of gw.stream(chain, req, ctl.signal)) events.push(e);
      })(),
    ).rejects.toBeDefined();
    expect(asked).toEqual(['fake/a']);
    expect(events.filter((e) => e.type === 'fallback')).toEqual([]);
  });

  it('asks no model at all when it is already stopped', async () => {
    const ctl = new AbortController();
    ctl.abort(new Error('cancelled'));
    const { gw, p } = gateway();
    await expect(
      (async () => {
        for await (const _ of gw.stream(chain, req, ctl.signal));
      })(),
    ).rejects.toBeDefined();
    expect(p.calls).toEqual([]);
  });
});
