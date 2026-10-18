/**
 * Each provider's list, parsed from small hand-written bodies shaped like the
 * documented answers (no network), and OpenRouter price matching.
 */
import { AncileError } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import {
  list,
  listError,
  matchOpenRouterPrice,
  normaliseForMatch,
  parseAnthropic,
  parseGoogle,
  parseOpenAi,
  parseOpenRouter,
  priceIndex,
} from '../../../src/models/watch/listers';

const ANTHROPIC = {
  data: [
    {
      id: 'claude-opus-5-5',
      display_name: 'Claude Opus 5.5',
      created_at: '2026-09-01T00:00:00Z',
      max_input_tokens: 200000,
      max_tokens: 64000,
      lifecycle: 'active',
      capabilities: {
        image_input: { supported: true },
        pdf_input: { supported: true },
        structured_outputs: { supported: true },
        thinking: { supported: true, types: ['adaptive'] },
        code_execution: { supported: false },
      },
    },
    {
      id: 'claude-3-5-sonnet-20241022',
      display_name: 'Old',
      lifecycle: 'retired',
      retires_at: '2026-10-28T00:00:00Z',
    },
    { display_name: 'no id' },
  ],
  has_more: false,
};

describe('Anthropic list', () => {
  it('reads limits, abilities and lifecycle, and tolerates missing fields', () => {
    const { models, next } = parseAnthropic(ANTHROPIC);
    expect(next).toBeNull();
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      provider_model: 'claude-opus-5-5',
      context_window: 200000,
      max_output: 64000,
      capsKnown: true,
      lifecycle: 'active',
      price: null,
    });
    expect(models[0]?.capabilities.sort()).toEqual(['json', 'reasoning', 'tools', 'vision']);
    expect(models[0]?.other_abilities).toEqual(['pdf_input']);
    expect(models[1]).toMatchObject({
      lifecycle: 'retired',
      retires_at: '2026-10-28T00:00:00Z',
      capsKnown: false,
    });
  });

  it('paginates with after_id and sends the workspace header for a personal key', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const out = await list(
      { kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1/', key: 'k', workspaceId: 'wrkspc_1' },
      async (url, headers) => {
        calls.push({ url, headers });
        return calls.length === 1
          ? { data: [{ id: 'claude-haiku-4-5' }], has_more: true, last_id: 'claude-haiku-4-5' }
          : { data: [{ id: 'claude-opus-5-5' }], has_more: false };
      },
    );
    expect(out.map((m) => m.provider_model)).toEqual(['claude-haiku-4-5', 'claude-opus-5-5']);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(calls[1]?.url).toContain('after_id=claude-haiku-4-5');
    expect(calls[0]?.headers['anthropic-workspace-id']).toBe('wrkspc_1');
    expect(calls[0]?.headers['x-api-key']).toBe('k');
  });
});

describe('OpenAI and compatible lists', () => {
  it('reads ids and, where given, a context length', () => {
    const { models } = parseOpenAi({
      data: [{ id: 'gpt-5.5', created: 1790000000 }, { id: 'deepseek-v4-pro', context_length: 128000 }, {}],
    });
    expect(models.map((m) => m.provider_model)).toEqual(['gpt-5.5', 'deepseek-v4-pro']);
    expect(models[0]?.created_at).toMatch(/^2026/);
    expect(models[1]?.context_window).toBe(128000);
    expect(models[0]?.capsKnown).toBe(false);
  });
});

describe('Gemini list', () => {
  it('keeps chat models, strips models/, reads limits and the next page', () => {
    const { models, next } = parseGoogle({
      models: [
        {
          name: 'models/gemini-3-pro',
          displayName: 'Gemini 3 Pro',
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
        },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      ],
      nextPageToken: 'abc',
    });
    expect(next).toBe('abc');
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      provider_model: 'gemini-3-pro',
      context_window: 1048576,
      max_output: 65536,
      price: null,
    });
  });

  it('sends the key in x-goog-api-key and follows pageToken', async () => {
    const urls: string[] = [];
    let key = '';
    await list(
      { kind: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', key: 'g' },
      async (u, h) => {
        urls.push(u);
        key = h['x-goog-api-key'] ?? '';
        return urls.length === 1 ? { models: [], nextPageToken: 'p2' } : { models: [] };
      },
    );
    expect(urls[1]).toContain('pageToken=p2');
    expect(key).toBe('g');
  });
});

const OPENROUTER = {
  data: [
    {
      id: 'anthropic/claude-opus-5.5',
      name: 'Anthropic: Claude Opus 5.5',
      context_length: 200000,
      pricing: {
        prompt: '0.000004',
        completion: '0.00002',
        input_cache_read: '0.0000002',
        input_cache_write: '0.000005',
      },
      top_provider: { context_length: 200000, max_completion_tokens: 64000 },
      architecture: { input_modalities: ['text', 'image'] },
      supported_parameters: ['tools', 'reasoning', 'response_format'],
    },
    { id: 'openai/gpt-5.5-2026-08-01', pricing: { prompt: '0.000002', completion: '0.00001' } },
    { id: 'openai/gpt-5.5:free', pricing: { prompt: '0', completion: '0' } },
    { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
    { id: 'google/gemini-3-pro-preview', pricing: { prompt: '0.00000125', completion: '0.00001' } },
  ],
};

describe('OpenRouter list and prices', () => {
  it('converts per-token strings to per million tokens, and reads abilities', () => {
    const { models } = parseOpenRouter(OPENROUTER);
    const opus = models[0];
    expect(opus?.price).toEqual({
      input_per_mtok: 4,
      output_per_mtok: 20,
      cached_per_mtok: 0.2,
      cache_write_per_mtok: 5,
    });
    expect(opus).toMatchObject({ context_window: 200000, max_output: 64000, capsKnown: true });
    expect(opus?.capabilities.sort()).toEqual(['json', 'reasoning', 'tools', 'vision']);
    // A router with a negative price has no price.
    expect(models.find((m) => m.provider_model === 'openrouter/auto')?.price).toBeNull();
  });

  it('matches direct models by vendor prefix: lowercase, dots to dashes, date stripped, exact only', () => {
    const idx = priceIndex(parseOpenRouter(OPENROUTER).models);
    expect(matchOpenRouterPrice(idx, 'anthropic', 'claude-opus-5-5')?.input_per_mtok).toBe(4);
    expect(matchOpenRouterPrice(idx, 'anthropic', 'claude-opus-5-5-20260901')?.input_per_mtok).toBe(4);
    expect(matchOpenRouterPrice(idx, 'openai', 'gpt-5.5')?.output_per_mtok).toBe(10);
    // Variants (:free) are not prices for the real model.
    expect(idx.has('openai/gpt-5-5:free')).toBe(false);
    // Similar is not the same.
    expect(matchOpenRouterPrice(idx, 'anthropic', 'claude-opus-5')).toBeNull();
    expect(matchOpenRouterPrice(idx, 'google', 'gemini-3-pro')).toBeNull();
    expect(matchOpenRouterPrice(idx, 'google', 'gemini-3-pro-preview')?.input_per_mtok).toBe(1.25);
    // A vendor we have no prefix for gets nothing.
    expect(matchOpenRouterPrice(idx, 'groq', 'gpt-5.5')).toBeNull();
    expect(matchOpenRouterPrice(idx, null, 'gpt-5.5')).toBeNull();
  });

  it('maps vendors to OpenRouter prefixes', () => {
    const idx = new Map([['moonshotai/kimi-k2', { input_per_mtok: 1, output_per_mtok: 2 }]]);
    expect(matchOpenRouterPrice(idx, 'moonshot', 'kimi-k2')?.output_per_mtok).toBe(2);
    expect(normaliseForMatch('Claude-Opus-5.5-20260901')).toBe('claude-opus-5-5');
  });

  it('sends no key to the public list', async () => {
    let headers: Record<string, string> | undefined;
    const { listOpenRouterPublic } = await import('../../../src/models/watch/listers');
    await listOpenRouterPublic(async (_u, h) => {
      headers = h;
      return OPENROUTER;
    });
    expect(headers).toEqual({});
  });
});

describe('list errors', () => {
  const fail = (status: number) => Object.assign(new Error('x'), { status });
  const code = (status: number) => {
    const e = listError(fail(status), 'api.example.com');
    expect(e).toBeInstanceOf(AncileError);
    return e.code;
  };

  it('never calls a key rejected for failing to list', () => {
    expect(code(401)).toBe('models.list_forbidden');
    expect(code(403)).toBe('models.list_forbidden');
    expect(listError(fail(403), 'h').title).not.toMatch(/reject/i);
  });

  it('treats busy and broken providers as retry-later', () => {
    expect(code(429)).toBe('models.list_unavailable');
    expect(code(503)).toBe('models.list_unavailable');
    expect(code(404)).toBe('models.list_failed');
    expect(code(418)).toBe('models.list_failed');
  });

  it('list() turns a failing getter into the documented error', async () => {
    await expect(
      list({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', key: 'k' }, async () => {
        throw fail(403);
      }),
    ).rejects.toMatchObject({ code: 'models.list_forbidden' });
  });
});
