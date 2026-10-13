/**
 * ------------------------------------------------------------------
 *  Title    |  A flow step that fell back says so
 *  Ref      |  DESIGN.md §16 · flows/call.ts
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  Found live: a step whose GPU node could not answer was
 *           |  answered by its fallback with nothing to show it. The
 *           |  call now records which model stood in, for the step's
 *           |  visible note. Also: a stopped node's plain-thread error.
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';
import { CircuitBreaker, ClassifiedError, instantClock } from '@nvx/resilience';
import { describe, expect, it } from 'vitest';
import { nodeStopped } from '../../src/conductor/pipeline';
import { streamCall } from '../../src/flows/call';
import { Gateway } from '../../src/gateway/gateway';
import type { ModelRegistry } from '../../src/gateway/registry';
import type { ModelClient, StreamChunk } from '../../src/gateway/types';

const model = (id: string): ModelConfig => ({
  id,
  provider: 'fake',
  provider_model: id,
  display_name: id,
  via: 'direct',
  family: 'x',
  context_window: 8_000,
  max_output: 500,
  capabilities: [],
  price: { input_per_mtok: 0, output_per_mtok: 0 },
  enabled: true,
});

const client: ModelClient = {
  async *stream(m: ModelConfig): AsyncGenerator<StreamChunk> {
    if (m.id === 'node/qwen') throw new ClassifiedError('capacity', 'the node did not wake');
    yield { type: 'text', delta: 'from the cloud' };
    yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
  },
};

describe('a flow step whose model could not answer', () => {
  it('records which model stood in, and why', async () => {
    const gateway = new Gateway({ client, breaker: new CircuitBreaker({ clock: instantClock() }) });
    const registry = { get: () => undefined } as unknown as ModelRegistry;
    const r = await streamCall(
      { gateway, registry },
      [model('node/qwen'), model('openai/gpt')],
      { messages: [{ role: 'user', content: 'hi' }] },
      new AbortController().signal,
      () => undefined,
    );
    expect(r.text).toBe('from the cloud');
    expect(r.fellBack).toEqual({ from: 'node/qwen', to: 'openai/gpt', reason: 'capacity' });
  });
});

describe('a stopped GPU node in a plain thread', () => {
  it('says the node is stopped, not that no model is ready', () => {
    const e = nodeStopped('node/qwen2.5-7b');
    expect(e.code).toBe('compute.node_stopped');
    expect(e.title).toBe('Your GPU node is stopped');
    expect(e.hint).toContain('Start node');
    expect(e.hint).toContain('qwen2.5-7b');
  });
});
