/**
 * What an answer records for its receipt (roadmap WY1): every model call with
 * its cache figures and cost, the rates and payer at the time, and the retries
 * that worked. Pure maths first, then a real turn through the conductor.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Message, ModelConfig, type ThreadPath, Usage } from '@nvx/contracts';
import { ClassifiedError, collectRecoveries, retry } from '@nvx/resilience';
import { afterEach, describe, expect, it } from 'vitest';
import {
  noteCall,
  noteRecovery,
  type RunningUsage,
  ratesOf,
  reasonOf,
  recoveryOf,
  stopOf,
  usageOut,
} from '../../src/conductor/receipt';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const model = ModelConfig.parse({
  id: 'anthropic/test',
  provider: 'anthropic',
  provider_model: 'test',
  display_name: 'Test',
  family: 'test',
  context_window: 200_000,
  max_output: 8_000,
  price: { input_per_mtok: 3, output_per_mtok: 15, cached_per_mtok: 0.3, cache_write_per_mtok: 3.75 },
});

const fresh = (): RunningUsage => ({ input: 0, output: 0, cached: 0, costUsd: 0 });

describe('noteCall', () => {
  it('keeps cache writes apart from reads and prices each at its own rate, never twice', () => {
    const u = fresh();
    // 1,000 prompt tokens: 600 read from cache, 100 written, 300 fresh. 200 out.
    const spent = noteCall(u, {
      model,
      modelId: model.id,
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        cachedTokens: 600,
        cacheWriteTokens: 100,
        cacheReported: true,
      },
      startedMs: 5,
      ms: 40,
      stop: 'end',
    });
    const expected = (300 * 3 + 600 * 0.3 + 100 * 3.75 + 200 * 15) / 1_000_000;
    expect(spent).toBeCloseTo(expected, 10);
    expect(u).toMatchObject({ input: 1000, output: 200, cached: 600, written: 100, cacheReported: true });
    expect(u.costUsd).toBeCloseTo(expected, 10);
    expect(u.calls?.[0]).toMatchObject({
      cached_tokens: 600,
      cache_write_tokens: 100,
      started_ms: 5,
      ms: 40,
      stop: 'end',
    });
  });

  it('counts what the provider billed as the spend, and keeps the list price beside it', () => {
    const u = fresh();
    noteCall(u, {
      model,
      modelId: model.id,
      usage: { inputTokens: 1000, outputTokens: 0 },
      startedMs: 0,
      ms: 1,
    });
    noteCall(u, {
      model,
      modelId: model.id,
      usage: { inputTokens: 1000, outputTokens: 0 },
      billedUsd: 0.01,
      startedMs: 1,
      ms: 1,
    });
    const list = (1000 * 3) / 1_000_000;
    expect(u.listUsd).toBeCloseTo(2 * list, 10);
    // the first call was not billed by the provider: its list price joins the billed total
    expect(u.billedUsd).toBeCloseTo(list + 0.01, 10);
    expect(u.costUsd).toBeCloseTo(list + 0.01, 10);
    expect(u.calls?.[1]).toMatchObject({ billed_usd: 0.01 });
    expect(u.calls?.[1]?.cost_usd).toBeCloseTo(list, 10);
  });

  it('keeps at most 50 calls but counts them all', () => {
    const u = fresh();
    for (let i = 0; i < 60; i++)
      noteCall(u, {
        model,
        modelId: model.id,
        usage: { inputTokens: 10, outputTokens: 1 },
        startedMs: i,
        ms: 1,
      });
    expect(u.calls).toHaveLength(50);
    expect(u.input).toBe(600);
    expect(u.output).toBe(60);
  });

  it('knows a cache count was never reported', () => {
    const u = fresh();
    noteCall(u, {
      model,
      modelId: model.id,
      usage: { inputTokens: 10, outputTokens: 1 },
      startedMs: 0,
      ms: 1,
    });
    const out = usageOut(u, { model, billing: null, ms: 12 });
    expect(out.cache_reported).toBe(false);
    expect(out.cache_write_tokens).toBe(0);
    expect(Usage.safeParse(out).success).toBe(true);
  });
});

describe('usageOut', () => {
  it('records the rates and who paid at the time, and the turn time', () => {
    const u = fresh();
    noteCall(u, {
      model,
      modelId: model.id,
      usage: { inputTokens: 10, outputTokens: 1 },
      startedMs: 0,
      ms: 1,
    });
    const out = usageOut(u, { model, billing: { kind: 'key', payer: 'anthropic' }, ms: 1234.4 });
    expect(out.rates).toEqual({ input: 3, cached: 0.3, cache_write: 3.75, output: 15 });
    expect(out.billing).toEqual({ kind: 'key', payer: 'anthropic' });
    expect(out.ms).toBe(1234);
    expect(out).not.toHaveProperty('billed_usd');
  });

  it('falls back to the input price for rates a model does not list', () => {
    const plain = ModelConfig.parse({ ...model, price: { input_per_mtok: 2, output_per_mtok: 8 } });
    expect(ratesOf(plain)).toEqual({ input: 2, cached: 2, cache_write: 2, output: 8 });
  });
});

describe('stopOf', () => {
  it('maps finish reasons to the receipt words', () => {
    expect(stopOf('tool-calls')).toBe('tool_calls');
    expect(stopOf('stop')).toBe('end');
    expect(stopOf('length')).toBe('length');
    expect(stopOf('weird')).toBeUndefined();
  });
});

describe('retries that worked', () => {
  it('are reported by retry to whoever is collecting, and by no one else', async () => {
    const seen: number[] = [];
    let n = 0;
    const flaky = async () => {
      n++;
      if (n < 3) throw new ClassifiedError('transient', 'rate limit reached', { status: 429 });
      return 'ok';
    };
    const out = await collectRecoveries(
      (i) => seen.push(i.attempts),
      () => retry(flaky, { baseMs: 1, capMs: 2, random: () => 0.5 }),
    );
    expect(out).toBe('ok');
    expect(seen).toEqual([3]);

    n = 0;
    await expect(retry(flaky, { baseMs: 1, capMs: 2 })).resolves.toBe('ok');
    expect(seen).toEqual([3]);
  });

  it('say why in a short code, and are capped at 20', () => {
    const base = { attempts: 2, waitedMs: 1200.4 };
    expect(
      reasonOf({ errorClass: 'transient', error: new ClassifiedError('transient', 'x', { status: 429 }) }),
    ).toBe('rate_limited');
    expect(reasonOf({ errorClass: 'transient', error: new Error('request timed out') })).toBe('timeout');
    expect(
      reasonOf({ errorClass: 'transient', error: new ClassifiedError('transient', 'x', { status: 503 }) }),
    ).toBe('server_error');
    expect(reasonOf({ errorClass: 'transient', error: new Error('socket hang up') })).toBe('network');
    const r = recoveryOf('tool', 'web_search', {
      ...base,
      errorClass: 'transient',
      error: new Error('timeout'),
    });
    expect(r).toEqual({ what: 'tool', name: 'web_search', attempts: 2, waited_ms: 1200, reason: 'timeout' });
    let list: ReturnType<typeof noteRecovery> | undefined;
    for (let i = 0; i < 30; i++) list = noteRecovery(list, r);
    expect(list).toHaveLength(20);
  });
});

describe('a real turn', () => {
  it('records every model call, the payer and the rates on the answer', async () => {
    h = await harness();
    await writeFile(join(h.dir, 'notes.md'), 'hello file');
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_read {"path":"notes.md"}');
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
    const path = (await h.call<ThreadPath>('GET', `/threads/${t}/path`)).body;
    const m = path.messages.at(-1) as Message;
    const u = m.usage;
    expect(u?.calls).toHaveLength(2);
    expect(u?.calls?.map((c) => c.stop)).toEqual(['tool_calls', 'end']);
    const [first, second] = u?.calls ?? [];
    expect(second?.started_ms).toBeGreaterThanOrEqual((first?.started_ms ?? 0) + (first?.ms ?? 0));
    expect(u?.calls?.reduce((s, c) => s + c.input_tokens, 0)).toBe(u?.input_tokens);
    expect(u?.billing).toEqual({ kind: 'none', payer: null });
    expect(u?.rates).toBeDefined();
    expect(u?.cache_reported).toBe(false);
    expect(u?.cache_write_tokens).toBe(0);
    expect(u?.ms).toEqual(expect.any(Number));
  });

  it('serves the same record from the explain endpoint, and answers for an older message without it', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, '/say hello');
    await h.settle(sent.run_id);
    const path = (await h.call<ThreadPath>('GET', `/threads/${t}/path`)).body;
    const m = path.messages.at(-1) as Message;
    const x = (
      await h.call<{ usage: Usage | null; recovered: unknown[] }>('GET', `/messages/${m.id}/explain`)
    ).body;
    expect(x.usage?.calls?.length).toBe(1);
    expect(x.recovered).toEqual([]);
  });
});
