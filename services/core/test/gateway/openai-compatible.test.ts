/**
 * ------------------------------------------------------------------
 *  Title    |  OpenAI-compatible servers (vLLM, Ollama, LM Studio)
 *  Ref      |  docs/models.md (Your own server, GPU nodes)
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  Found live on a RunPod node: streamed answers came back
 *           |  with no usage (every count read zero), and tools were
 *           |  offered to a model without them, which vLLM refuses.
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiSdkClient } from '../../src/gateway/providers';
import type { StreamChunk } from '../../src/gateway/types';

const node: ModelConfig = {
  id: 'node/qwen',
  provider: 'endpoint-pod',
  provider_model: 'qwen',
  display_name: 'Qwen on a pod',
  via: 'direct',
  family: 'qwen',
  context_window: 8_000,
  max_output: 512,
  capabilities: [],
  price: { input_per_mtok: 0, output_per_mtok: 0 },
  enabled: true,
  base_url: 'http://pod.test/v1',
};

const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('an OpenAI-compatible server', () => {
  it('is asked for usage in the stream, and is not offered tools it does not take', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return sse([
          {
            id: '1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'qwen',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }],
          },
          {
            id: '1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'qwen',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          },
          {
            id: '1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'qwen',
            choices: [],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 2,
              total_tokens: 122,
              prompt_tokens_details: { cached_tokens: 64 },
            },
          },
        ]);
      }),
    );
    const client = new AiSdkClient({ get: async () => undefined }, {});
    const out: StreamChunk[] = [];
    for await (const c of client.stream(
      node,
      {
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          { name: 'fs_read', description: 'Read a file', inputSchema: { type: 'object', properties: {} } },
        ],
      },
      new AbortController().signal,
    ))
      out.push(c);
    expect(bodies[0]?.stream_options).toEqual({ include_usage: true });
    expect(bodies[0]?.tools).toBeUndefined();
    expect(out.at(-1)).toMatchObject({
      type: 'finish',
      usage: { inputTokens: 120, outputTokens: 2, cachedTokens: 64 },
    });
  });
});
