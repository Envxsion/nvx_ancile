/**
 * ------------------------------------------------------------------
 *  Title    |  Ollama through its own chat API
 *  Ref      |  docs/models.md (Ollama)
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  Found live: through /v1 Ollama kept its 2,048-token
 *           |  server default and read 2,050 tokens of a 4.2k prompt.
 *           |  Now every call names num_ctx, assembly budgets to the
 *           |  same window, and a cut prompt is reported once.
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import {
  looksTruncated,
  OLLAMA_MAX_CONTEXT,
  ollamaChat,
  servedWindow,
  TRUNCATED_WARNING,
} from '../../src/gateway/ollama-chat';
import { AiSdkClient } from '../../src/gateway/providers';
import type { StreamChunk } from '../../src/gateway/types';

const qwen: ModelConfig = {
  id: 'ollama/qwen3:8b',
  provider: 'ollama',
  provider_model: 'qwen3:8b',
  display_name: 'Qwen3 8B',
  via: 'direct',
  family: 'qwen',
  context_window: 16_384,
  max_output: 1_024,
  capabilities: ['tools'],
  price: { input_per_mtok: 0, output_per_mtok: 0 },
  enabled: true,
  base_url: 'http://192.168.1.20:11434/v1',
};

const ndjson = (lines: unknown[]) =>
  new Response(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, {
    headers: { 'content-type': 'application/x-ndjson' },
  });

async function collect(it: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

const long = 'word '.repeat(4_000); // about 5k tokens by the 4-chars rule

describe('Ollama as a model', () => {
  it('posts to /api/chat with num_ctx from the model window, and maps the stream', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return ndjson([
        { message: { role: 'assistant', content: 'Hel' }, done: false },
        { message: { role: 'assistant', content: 'lo' }, done: false },
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'search', arguments: { q: 'x' } } }],
          },
          done: false,
        },
        {
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 30,
          eval_count: 4,
        },
      ]);
    }) as unknown as typeof globalThis.fetch;
    const out = await collect(
      ollamaChat(
        qwen,
        {
          system: 'Be brief.',
          messages: [{ role: 'user', content: 'Hi' }],
          tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
          maxOutputTokens: 200,
        },
        new AbortController().signal,
        { baseUrl: qwen.base_url as string, fetch, warned: new Set() },
      ),
    );
    expect(calls[0]?.url).toBe('http://192.168.1.20:11434/api/chat');
    const body = calls[0]?.body as {
      options: { num_ctx: number; num_predict: number };
      messages: { role: string }[];
      tools: unknown[];
    };
    expect(body.options).toMatchObject({ num_ctx: 16_384, num_predict: 200 });
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(body.tools).toHaveLength(1);
    expect(
      out
        .filter((c) => c.type === 'text')
        .map((c) => (c as { delta: string }).delta)
        .join(''),
    ).toBe('Hello');
    expect(out.find((c) => c.type === 'tool_call')).toMatchObject({ tool: 'search', args: { q: 'x' } });
    expect(out.at(-1)).toMatchObject({
      type: 'finish',
      finishReason: 'tool-calls',
      usage: { inputTokens: 30, outputTokens: 4 },
    });
    expect(out.some((c) => c.type === 'warning')).toBe(false);
  });

  it('sends num_gpu only when a preset chose it, and 0 counts as chosen', async () => {
    const bodies: { options: Record<string, unknown> }[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return ndjson([
        { message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 1 },
      ]);
    }) as unknown as typeof globalThis.fetch;
    for (const local of [undefined, { numCtx: 4096 }, { numGpu: 0 }, { numGpu: 24 }])
      await collect(
        ollamaChat(
          qwen,
          { messages: [{ role: 'user', content: 'Hi' }], ...(local && { local }) },
          new AbortController().signal,
          { baseUrl: qwen.base_url as string, fetch, warned: new Set() },
        ),
      );
    expect(bodies.map((b) => b.options.num_gpu)).toEqual([undefined, undefined, 0, 24]);
  });

  it('warns once per thread when Ollama read only part of the prompt', async () => {
    const fetch = (async () =>
      ndjson([
        { message: { content: 'ok' }, done: false },
        {
          message: { content: '' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 2_050,
          eval_count: 1,
        },
      ])) as unknown as typeof globalThis.fetch;
    const warned = new Set<string>();
    const run = () =>
      collect(
        ollamaChat(
          qwen,
          { messages: [{ role: 'user', content: long }], meta: { threadId: 't1' } },
          new AbortController().signal,
          { baseUrl: 'http://localhost:11434', fetch, warned },
        ),
      );
    const first = await run();
    expect(first.find((c) => c.type === 'warning')).toEqual({ type: 'warning', ...TRUNCATED_WARNING });
    expect(TRUNCATED_WARNING.message).toMatch(/^This local model only read part of the conversation/);
    const second = await run();
    expect(second.some((c) => c.type === 'warning')).toBe(false);
  });

  it('tells a cut prompt from a cached prefix', () => {
    expect(looksTruncated(4_200, 2_050, 8_192)).toBe(true);
    // A warm cache: Ollama counts only the new tokens, nowhere near a window.
    expect(looksTruncated(4_200, 60, 8_192)).toBe(false);
    expect(looksTruncated(4_200, 4_150, 8_192)).toBe(false);
  });

  it('budgets context to the window Ollama is asked for', () => {
    expect(servedWindow(qwen)).toBe(16_384);
    expect(servedWindow({ ...qwen, context_window: 131_072 })).toBe(OLLAMA_MAX_CONTEXT);
    expect(servedWindow({ ...qwen, provider: 'openai', context_window: 131_072 })).toBe(131_072);
    expect(servedWindow({ ...qwen, via: 'controller', context_window: 131_072 })).toBe(131_072);
  });

  it('is what the production client uses for ollama models', async () => {
    const urls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return ndjson([{ message: { content: 'hi' }, done: true, prompt_eval_count: 5, eval_count: 1 }]);
    }) as unknown as typeof globalThis.fetch;
    try {
      const client = new AiSdkClient({ get: async () => undefined }, {});
      await collect(
        client.stream(qwen, { messages: [{ role: 'user', content: 'Hi' }] }, new AbortController().signal),
      );
    } finally {
      globalThis.fetch = real;
    }
    expect(urls).toEqual(['http://192.168.1.20:11434/api/chat']);
  });
});
