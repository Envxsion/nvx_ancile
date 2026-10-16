/**
 * ------------------------------------------------------------------
 *  Title    |  One meaning for usage, whoever served the call (CA0)
 *  Ref      |  gateway/usage.ts
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  DeepSeek names its cache hits prompt_cache_hit_tokens,
 *           |  which the AI SDK does not read, so every hit counted as
 *           |  zero; Anthropic's input_tokens leaves cache reads and
 *           |  writes out, so costs came out low. Both now arrive as
 *           |  every prompt token in input, with hits and writes apart.
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiSdkClient } from '../../src/gateway/providers';
import type { StreamChunk } from '../../src/gateway/types';
import { cacheFromRaw, priceOf, usageNumbers } from '../../src/gateway/usage';

const base: Omit<ModelConfig, 'id' | 'provider' | 'provider_model' | 'price'> = {
  display_name: 'Test',
  via: 'direct',
  family: 'test',
  context_window: 100_000,
  max_output: 1_000,
  capabilities: [],
  enabled: true,
};

const deepseek: ModelConfig = {
  ...base,
  id: 'deepseek/flash',
  provider: 'deepseek',
  provider_model: 'deepseek-chat',
  base_url: 'https://deepseek.test/v1',
  price: { input_per_mtok: 0.3, output_per_mtok: 1.2, cached_per_mtok: 0.006 },
};

const claude: ModelConfig = {
  ...base,
  id: 'anthropic/test',
  provider: 'anthropic',
  provider_model: 'claude-test',
  price: { input_per_mtok: 4, output_per_mtok: 20, cached_per_mtok: 0.2, cache_write_per_mtok: 5 },
};

afterEach(() => vi.unstubAllGlobals());

const finishOf = async (client: AiSdkClient, m: ModelConfig) => {
  const out: StreamChunk[] = [];
  for await (const c of client.stream(
    m,
    { messages: [{ role: 'user', content: 'Hi' }] },
    new AbortController().signal,
  ))
    out.push(c);
  return out.find((c) => c.type === 'finish');
};

describe('priceOf', () => {
  it('prices fresh, cached and written prompt tokens at their own rates', () => {
    const usd = priceOf(claude, {
      inputTokens: 1_000_000 + 2_000_000 + 100_000,
      cachedTokens: 2_000_000,
      cacheWriteTokens: 100_000,
      outputTokens: 10_000,
    });
    // 1M fresh × $4 + 2M read × $0.20 + 0.1M written × $5 + 10k out × $20
    expect(usd).toBeCloseTo(4 + 0.4 + 0.5 + 0.2, 6);
  });

  it('never goes negative when a provider reports more hits than input', () => {
    expect(priceOf(deepseek, { inputTokens: 10, cachedTokens: 50, outputTokens: 0 })).toBeGreaterThanOrEqual(
      0,
    );
  });
});

describe('cacheFromRaw', () => {
  it('reads hits and writes under every name providers use', () => {
    expect(cacheFromRaw({ prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 })).toEqual({
      hit: 900,
    });
    expect(cacheFromRaw({ prompt_tokens_details: { cached_tokens: 64, cache_write_tokens: 12 } })).toEqual({
      hit: 64,
      write: 12,
    });
    expect(cacheFromRaw({ cache_read_input_tokens: 5, cache_creation_input_tokens: 7 })).toEqual({
      hit: 5,
      write: 7,
    });
    expect(cacheFromRaw(undefined)).toEqual({});
  });

  it('keeps only numbers for the log line', () => {
    expect(usageNumbers({ a: 1, b: 'x', c: { d: 2, e: null } })).toEqual({ a: 1, 'c.d': 2 });
  });
});

describe('providers report usage the same way', () => {
  it('counts DeepSeek hits (prompt_cache_hit_tokens), which used to read zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const chunks = [
          {
            id: '1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'deepseek-chat',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
          },
          {
            id: '1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'deepseek-chat',
            choices: [],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 2,
              total_tokens: 1002,
              prompt_cache_hit_tokens: 896,
              prompt_cache_miss_tokens: 104,
            },
          },
        ];
        return new Response(
          `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`,
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        );
      }),
    );
    const seen: [string, Record<string, number>][] = [];
    const client = new AiSdkClient(
      { get: async () => 'sk-test' },
      { onRawUsage: (p, u) => seen.push([p, u]) },
    );
    const finish = await finishOf(client, deepseek);
    expect(finish).toMatchObject({ usage: { inputTokens: 1000, cachedTokens: 896, outputTokens: 2 } });
    expect(seen[0]?.[0]).toBe('deepseek');
    expect(seen[0]?.[1]).toMatchObject({ prompt_cache_hit_tokens: 896 });
  });

  it("adds Anthropic's cache reads and writes back into input", async () => {
    const events: [string, unknown][] = [
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-test',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 40,
              cache_read_input_tokens: 9000,
              cache_creation_input_tokens: 500,
              output_tokens: 1,
            },
          },
        },
      ],
      [
        'content_block_start',
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ],
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 3 },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ];
    const headers: Record<string, string>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        headers.push(Object.fromEntries(new Headers(init.headers).entries()));
        return new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }),
    );
    const secrets = {
      get: async (name: string) => (name === 'ANTHROPIC_WORKSPACE_ID' ? 'wrkspc_01TEST' : 'sk-test'),
    };
    const finish = await finishOf(new AiSdkClient(secrets, {}), claude);
    expect(finish).toMatchObject({
      usage: { inputTokens: 9540, cachedTokens: 9000, cacheWriteTokens: 500, outputTokens: 3 },
    });
    // AK1: the workspace a personal key bills goes on every Anthropic call.
    expect(headers[0]?.['anthropic-workspace-id']).toBe('wrkspc_01TEST');
  });
});
