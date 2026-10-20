/**
 * Every model call Ancile makes is counted, with its purpose: the gateway records a finished call
 * unless it is a chat answer (which its message already counts), and the report adds the ledger to the
 * messages, split by purpose.
 */
import type { ModelConfig } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { Gateway } from '../../src/gateway/gateway';
import type { ModelClient, ModelRequest, StreamChunk } from '../../src/gateway/types';
import { COUNTED_ON_MESSAGE, MemoryCallLedger, purposeOfPrompt } from '../../src/usage/ledger';
import { buildReport, MemoryUsageSource, window } from '../../src/usage/report';

const model: ModelConfig = {
  id: 'openai/gpt-5',
  provider: 'openai',
  provider_model: 'gpt-5',
  display_name: 'GPT',
  via: 'direct',
  family: 'openai',
  context_window: 100_000,
  max_output: 8_000,
  capabilities: [],
  price: { input_per_mtok: 2, output_per_mtok: 10 },
  enabled: true,
};

const client: ModelClient = {
  async *stream(_m: ModelConfig, _r: ModelRequest): AsyncIterable<StreamChunk> {
    yield { type: 'text', delta: 'Hello there, friend.' };
    yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1_000, outputTokens: 100 } };
  },
};

async function run(g: Gateway, purpose?: string) {
  const ac = new AbortController();
  for await (const _ of g.stream([model], { messages: [{ role: 'user', content: 'x' }] }, ac.signal, {
    ...(purpose && { purpose }),
  })) {
    /* drain */
  }
}

describe('the gateway records what is not a chat answer', () => {
  it('records the purpose, tokens and price of a call', async () => {
    const ledger = new MemoryCallLedger();
    await run(new Gateway({ client, ledger }), 'factcheck');
    expect(ledger.calls).toHaveLength(1);
    expect(ledger.calls[0]).toMatchObject({
      purpose: 'factcheck',
      modelId: 'openai/gpt-5',
      inputTokens: 1_000,
      outputTokens: 100,
      engine: 'gateway',
    });
    // 1000 in at $2 and 100 out at $10, per million.
    expect(ledger.calls[0]?.costUsd).toBeCloseTo(0.003, 6);
  });

  it('a call whose caller names no purpose is "other", never dropped', async () => {
    const ledger = new MemoryCallLedger();
    await run(new Gateway({ client, ledger }));
    expect(ledger.calls.map((c) => c.purpose)).toEqual(['other']);
  });

  it('a part of Ancile given its own view counts under its own purpose', async () => {
    const ledger = new MemoryCallLedger();
    const g = new Gateway({ client, ledger });
    await run(g.as('memory'));
    await run(g.as('memory'), 'title');
    expect(ledger.calls.map((c) => c.purpose)).toEqual(['memory', 'title']);
  });

  it('chat answers are left to their message, so nothing counts twice', async () => {
    const ledger = new MemoryCallLedger();
    const g = new Gateway({ client, ledger });
    for (const p of COUNTED_ON_MESSAGE) await run(g, p);
    expect(ledger.calls).toEqual([]);
  });

  it('prompt files map to a purpose', () => {
    expect(purposeOfPrompt('threads.title')).toBe('title');
    expect(purposeOfPrompt('threads.compare')).toBe('compare');
    expect(purposeOfPrompt('threads.compact')).toBe('thread');
    expect(purposeOfPrompt('memory.passive')).toBe('memory');
    expect(purposeOfPrompt('factcheck.verify-claim')).toBe('factcheck');
    expect(purposeOfPrompt('something.else')).toBe('other');
  });
});

describe('the usage report splits spend by purpose', () => {
  it('adds the ledger to the totals and lists each purpose', async () => {
    const ws = 'wsp_01TESTWORKSPACE000000000000';
    const ledger = new MemoryCallLedger(ws);
    const at = new Date('2099-10-12T10:00:00Z');
    const call = (purpose: string, i: number, usd: number) =>
      ledger.record({
        purpose,
        engine: 'gateway',
        modelId: 'openai/gpt-5',
        provider: null,
        inputTokens: i,
        outputTokens: 1,
        cachedTokens: 0,
        costUsd: usd,
        at,
      });
    await call('factcheck', 100, 0.01);
    await call('factcheck', 50, 0.005);
    await call('memory', 20, 0.001);
    const source = new MemoryUsageSource({
      messages: () => [],
      workspaceOf: () => ws,
      runKind: () => null,
      calls: () => ledger.calls,
    });
    const w = window('day', 'UTC', at.getTime());
    const rows = await source.rows({ workspaceId: ws, tz: 'UTC', bucket: 'hour', from: w.from, to: w.to });
    const report = buildReport('day', 'UTC', w, rows);
    expect(report.by_purpose.map((p) => [p.purpose, p.calls, p.input_tokens])).toEqual([
      ['factcheck', 2, 150],
      ['memory', 1, 20],
    ]);
    expect(report.totals.cost_usd).toBeCloseTo(0.016, 6);
    // They are model calls, not chat answers.
    expect(report.totals.answers).toBe(0);
  });
});
