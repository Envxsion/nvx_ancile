/**
 * Ollama's OpenAI-compatible endpoint sends its token counts in a stream
 * only when asked (stream_options.include_usage): the provider asks, and
 * the counts reach the answer's finish. A fake fetch, no Ollama.
 */
import type { ModelConfig } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { languageModelFor } from '../../src/gateway/providers';

const model: ModelConfig = {
  id: 'ollama/llama3.2:3b',
  provider: 'ollama',
  provider_model: 'llama3.2:3b',
  display_name: 'Llama 3.2 3B',
  via: 'direct',
  family: 'llama',
  context_window: 8192,
  max_output: 2048,
  capabilities: [],
  price: { input_per_mtok: 0, output_per_mtok: 0 },
  enabled: true,
};

const sse = (chunks: unknown[]) =>
  new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });

describe('Ollama token counts', () => {
  it('asks for usage in a stream and reads it', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'llama3.2:3b' };
      return sse([
        {
          ...base,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }],
        },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { ...base, choices: [], usage: { prompt_tokens: 26, completion_tokens: 3, total_tokens: 29 } },
      ]);
    }) as unknown as typeof globalThis.fetch;
    const lm = (await languageModelFor(model, { get: async () => undefined }, { fetch })) as unknown as {
      doStream(
        o: unknown,
      ): Promise<{ stream: ReadableStream<{ type: string; usage?: Record<string, number> }> }>;
    };
    const { stream } = await lm.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    });
    let usage: Record<string, number> | undefined;
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.type === 'finish') usage = value.usage;
    }
    expect(bodies[0]?.stream_options).toEqual({ include_usage: true });
    expect(usage).toMatchObject({ inputTokens: 26, outputTokens: 3 });
  });
});
