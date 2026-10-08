/**
 * Phase 5: a model on a GPU node that is asleep. The gateway says the node
 * is waking, waits, asks again, and streams the answer once it is up; or
 * falls through to the next model when the person chooses the cloud.
 */
import type { ModelConfig } from '@nvx/contracts';
import { CircuitBreaker, instantClock } from '@nvx/resilience';
import { describe, expect, it } from 'vitest';
import { runWithContext } from '../../src/context';
import { nodeWakingFrom, useCloud } from '../../src/gateway/compute';
import { Gateway } from '../../src/gateway/gateway';
import type { GatewayEvent, ModelClient, StreamChunk } from '../../src/gateway/types';

/** What the AI SDK throws for the Controller's 503. */
function wakingError(retryAfter = '0') {
  return Object.assign(new Error('Service Unavailable'), {
    statusCode: 503,
    responseHeaders: { 'retry-after': retryAfter },
    responseBody: JSON.stringify({
      error: {
        code: 'node_waking',
        message: 'Studio A100 is stopped; waking it now.',
        eta_s: 90,
        node_id: 'nod_1',
      },
    }),
  });
}

const model = (id: string, via: 'controller' | 'direct'): ModelConfig => ({
  id,
  provider: via === 'controller' ? 'node' : 'fake',
  provider_model: id,
  display_name: id,
  via,
  family: id.split('/')[0] ?? 'x',
  context_window: 8000,
  max_output: 1000,
  capabilities: [],
  price: { input_per_mtok: 0, output_per_mtok: 0 },
  enabled: true,
});

/** A node that answers after `sleepy` wake errors; the cloud model always answers. */
function client(sleepy: number): ModelClient & { calls: number } {
  const c = {
    calls: 0,
    async *stream(m: ModelConfig): AsyncGenerator<StreamChunk> {
      if (m.via === 'controller') {
        c.calls++;
        if (c.calls <= sleepy) throw wakingError();
        yield { type: 'text', delta: 'from the node' };
      } else {
        yield { type: 'text', delta: 'from the cloud' };
      }
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return c;
}

async function run(gw: Gateway, chain: ModelConfig[], runId = 'run_test') {
  const events: GatewayEvent[] = [];
  await runWithContext(
    { traceId: 't'.repeat(32), spanId: 's'.repeat(16), runId, component: 'test' },
    async () => {
      for await (const e of gw.stream(
        chain,
        { messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal,
      ))
        events.push(e);
    },
  );
  const text = events
    .map((e) => (e.type === 'chunk' && e.chunk.type === 'text' ? e.chunk.delta : ''))
    .join('');
  return { events, text };
}

const gw = (c: ModelClient, computeWaitMs = 60_000) =>
  new Gateway({
    client: c,
    breaker: new CircuitBreaker({ clock: instantClock() }),
    computeWaitMs,
    computePollMs: 1,
  });

describe('waiting for a GPU node', () => {
  it("reads the Controller's node_waking answer through the SDK's wrapping", () => {
    expect(nodeWakingFrom({ lastError: wakingError('7') })).toEqual({
      nodeId: 'nod_1',
      etaS: 90,
      retryAfterS: 7,
      message: 'Studio A100 is stopped; waking it now.',
    });
    expect(nodeWakingFrom(new Error('boom'))).toBeNull();
  });

  it('says the node is waking, waits, and streams from it once it is up', async () => {
    const c = client(2);
    const r = await run(gw(c), [model('node/llama', 'controller'), model('fake/cloud', 'direct')]);
    expect(r.text).toBe('from the node');
    const waits = r.events.filter((e) => e.type === 'compute_waiting');
    expect(waits).toHaveLength(2);
    expect(waits[0]).toMatchObject({ nodeId: 'nod_1', etaS: 90, canUseCloud: true });
    expect(r.events.some((e) => e.type === 'fallback')).toBe(false);
  });

  it('falls through to the cloud when the person asks', async () => {
    const c = client(1_000);
    setTimeout(() => useCloud('run_cloud'), 30);
    const r = await run(
      gw(c),
      [model('node/llama', 'controller'), model('fake/cloud', 'direct')],
      'run_cloud',
    );
    expect(r.text).toBe('from the cloud');
    expect(r.events.find((e) => e.type === 'fallback')).toMatchObject({ reason: 'capacity' });
  });

  it('gives up after the wait budget and falls back', async () => {
    const c = client(1_000);
    const r = await run(
      gw(c, 1),
      [model('node/llama', 'controller'), model('fake/cloud', 'direct')],
      'run_slow',
    );
    expect(r.text).toBe('from the cloud');
  });
});
