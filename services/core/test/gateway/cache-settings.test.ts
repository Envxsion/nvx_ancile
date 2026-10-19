/**
 * ------------------------------------------------------------------
 *  Title    |  Per-provider cache settings (CA5)
 *  Ref      |  ROADMAP.md CA5 · docs/prompt-caching.md
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  Capture what each client sends and require the cache
 *           |  settings the plan names: Anthropic markers in the right
 *           |  places and never more than four, cache keys that hold
 *           |  across a branch and differ between branches and shards,
 *           |  xAI's conversation id, OpenRouter's pinned provider,
 *           |  and retries that send exactly the same body.
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  anthropicBreakpoints,
  anthropicMinTokens,
  cacheExtras,
  cacheKey,
  PinBook,
  warmWindow,
} from '../../src/gateway/cache';
import { Gateway } from '../../src/gateway/gateway';
import { AiSdkClient } from '../../src/gateway/providers';
import type { CacheScope, ModelMessage, ModelRequest, StreamChunk } from '../../src/gateway/types';

const base = {
  via: 'direct' as const,
  family: 'test',
  context_window: 200_000,
  max_output: 8_000,
  capabilities: ['tools'],
  price: { input_per_mtok: 1, output_per_mtok: 2 },
  enabled: true,
};
const model = (provider: string, provider_model: string, extra: Partial<ModelConfig> = {}): ModelConfig =>
  ({
    ...base,
    id: `${provider}/${provider_model}`,
    provider,
    provider_model,
    display_name: provider_model,
    ...extra,
  }) as ModelConfig;

const anthropic = model('anthropic', 'claude-sonnet-5-5', { base_url: 'http://anthropic.test/v1' });
const openai = model('openai', 'gpt-5.6', { base_url: 'http://openai.test/v1' });
const mistral = model('mistral', 'mistral-large', { base_url: 'http://mistral.test/v1' });
const xai = model('xai', 'grok-4.7');
const openrouter = model('openrouter', 'deepseek/deepseek-v4-pro');

const scope: CacheScope = { threadId: 'thr_1', branch: 'msg_a', epochId: 'epc_1' };
const secrets = { get: async () => 'test-key' };
const words = (n: number) => `${'lorem ipsum dolor sit amet '.repeat(Math.ceil(n / 5)).slice(0, n * 5)}`;

const turn = (n: number): ModelMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `${i}: ${words(300)}`,
  }));

const TOOLS = [
  { name: 'a_tool', description: words(400), inputSchema: { type: 'object', properties: {} } },
  { name: 'z_tool', description: words(400), inputSchema: { type: 'object', properties: {} } },
];

interface Seen {
  url: string;
  text: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A client over a fetch that records every request and answers from `respond`. */
function rig(
  respond: (n: number) => Response = () => new Response('{"error":{"message":"stop"}}', { status: 500 }),
) {
  const seen: Seen[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(init?.body ?? '');
    seen.push({
      url: String(url),
      text,
      body: JSON.parse(text || '{}'),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return respond(seen.length);
  }) as unknown as typeof globalThis.fetch;
  return { seen, fetch };
}

async function run(
  client: AiSdkClient,
  m: ModelConfig,
  req: Partial<ModelRequest>,
): Promise<{ chunks: StreamChunk[]; error?: unknown }> {
  const chunks: StreamChunk[] = [];
  try {
    for await (const c of client.stream(m, { messages: turn(3), ...req }, new AbortController().signal))
      chunks.push(c);
    return { chunks };
  } catch (error) {
    return { chunks, error };
  }
}

const markers = (text: string) => (text.match(/"cache_control"/g) ?? []).length;

describe('the cache key', () => {
  it('is the same for every turn of a branch, and differs by branch, epoch, thread and shard', () => {
    const k = cacheKey(scope);
    expect(cacheKey({ ...scope })).toBe(k);
    expect(cacheKey({ ...scope, branch: 'msg_b' })).not.toBe(k);
    expect(cacheKey({ ...scope, epochId: 'epc_2' })).not.toBe(k);
    expect(cacheKey({ ...scope, threadId: 'thr_2' })).not.toBe(k);
    const shards = ['beam:a', 'beam:b', 'judge:1'].map((shard) => cacheKey({ ...scope, shard }));
    expect(new Set([k, ...shards]).size).toBe(4);
    expect(k).toMatch(/^nvx-[0-9a-f]{32}$/);
  });
});

describe('Anthropic breakpoints', () => {
  const min = 1024;

  it('marks the ends of what an epoch freezes and the last two messages: four, no more', () => {
    const plan = anthropicBreakpoints({
      toolsTokens: 800,
      system: [600, 900],
      messages: [500, 500, 500],
      min,
    });
    expect(plan).toEqual({ tools: false, system: [0, 1], messages: [1, 2] });
  });

  it('with no snapshot split, marks the tools and the system prompt instead', () => {
    const plan = anthropicBreakpoints({ toolsTokens: 1500, system: [2000], messages: [100, 100], min });
    expect(plan).toEqual({ tools: true, system: [0], messages: [0, 1] });
  });

  it('leaves a marker off a prefix under the minimum, which would waste one of the four', () => {
    const plan = anthropicBreakpoints({ toolsTokens: 200, system: [300, 300], messages: [100, 100], min });
    expect(plan).toEqual({ tools: false, system: [], messages: [] });
    const some = anthropicBreakpoints({ toolsTokens: 200, system: [300, 300], messages: [100, 600], min });
    // Rules (500) and snapshot (800) are under; the last message reaches 1400.
    expect(some).toEqual({ tools: false, system: [], messages: [1] });
  });

  it('knows each model line’s minimum, and takes the strictest for one it does not know', () => {
    expect(anthropicMinTokens('claude-sonnet-5-5')).toBe(512);
    expect(anthropicMinTokens('claude-opus-4-5-20251101')).toBe(4096);
    expect(anthropicMinTokens('claude-haiku-4-5')).toBe(4096);
    expect(anthropicMinTokens('claude-opus-4-7')).toBe(2048);
    expect(anthropicMinTokens('claude-sonnet-4-5')).toBe(1024);
    expect(anthropicMinTokens('claude-future-9')).toBe(4096);
  });

  it('puts them on the wire: tools or rules, the snapshot, and the last two messages, at most four', async () => {
    const { seen, fetch } = rig();
    const rules = words(900);
    const snapshot = words(900);
    await run(new AiSdkClient(secrets, { fetch }), anthropic, {
      system: `${rules}\n\n${snapshot}`,
      systemBlocks: [rules, snapshot],
      messages: turn(5),
      tools: TOOLS,
      toolChoice: 'auto',
      cache: scope,
    });
    const body = seen[0]?.body as {
      system: { text: string; cache_control?: unknown }[];
      messages: { role: string; content: { cache_control?: unknown }[] }[];
      tools: { name: string; cache_control?: unknown }[];
    };
    expect(markers(seen[0]?.text ?? '')).toBeLessThanOrEqual(4);
    expect(body.system).toHaveLength(2);
    expect(body.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[1]?.cache_control).toEqual({ type: 'ephemeral' });
    const withMark = body.messages.map((m, i) => ({ i, marked: m.content.some((c) => c.cache_control) }));
    expect(withMark.filter((x) => x.marked).map((x) => x.i)).toEqual([
      body.messages.length - 2,
      body.messages.length - 1,
    ]);
    // Tools are covered by the marker after the rules, so none is marked on its own here.
    expect(body.tools.some((t) => t.cache_control)).toBe(false);
  });

  it('marks the tools and the system prompt when the system is not split', async () => {
    const { seen, fetch } = rig();
    await run(new AiSdkClient(secrets, { fetch }), anthropic, {
      system: words(900),
      messages: turn(3),
      tools: TOOLS,
      toolChoice: 'auto',
      cache: scope,
    });
    const body = seen[0]?.body as { tools: { name: string; cache_control?: unknown }[] };
    expect(body.tools.map((t) => !!t.cache_control)).toEqual([false, true]);
    expect(markers(seen[0]?.text ?? '')).toBeLessThanOrEqual(4);
  });

  it('puts none on a short prompt: every prefix is under the model’s minimum', async () => {
    const { seen, fetch } = rig();
    await run(new AiSdkClient(secrets, { fetch }), anthropic, {
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'hi' }],
      cache: scope,
    });
    expect(markers(seen[0]?.text ?? '')).toBe(0);
  });

  it('is byte for byte the same when the same request is sent again', async () => {
    const { seen, fetch } = rig();
    const client = new AiSdkClient(secrets, { fetch });
    const req = {
      system: `${words(900)}\n\n${words(900)}`,
      messages: turn(5),
      tools: TOOLS,
      toolChoice: 'auto' as const,
      cache: scope,
    };
    await run(client, anthropic, req);
    await run(client, anthropic, req);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.text).toBe(seen[0]?.text);
  });
});

describe('cache keys on the wire', () => {
  it('OpenAI: prompt_cache_key is stable across the turns of a branch, differs by branch and shard', async () => {
    const { seen, fetch } = rig();
    const client = new AiSdkClient(secrets, { fetch });
    await run(client, openai, { messages: turn(3), cache: scope });
    await run(client, openai, { messages: turn(5), cache: scope });
    await run(client, openai, { messages: turn(5), cache: { ...scope, branch: 'msg_b' } });
    await run(client, openai, { messages: turn(5), cache: { ...scope, shard: 'beam:2' } });
    const keys = seen.map((s) => s.body.prompt_cache_key);
    expect(keys[0]).toBe(cacheKey(scope));
    expect(keys[1]).toBe(keys[0]);
    expect(new Set(keys).size).toBe(3);
  });

  it('Mistral: prompt_cache_key is sent', async () => {
    const { seen, fetch } = rig();
    await run(new AiSdkClient(secrets, { fetch }), mistral, { cache: scope });
    expect(seen[0]?.body.prompt_cache_key).toBe(cacheKey(scope));
  });

  it('xAI: the conversation id header is the key', async () => {
    const { seen, fetch } = rig();
    await run(new AiSdkClient(secrets, { fetch }), xai, { cache: scope });
    expect(seen[0]?.headers['x-grok-conv-id']).toBe(cacheKey(scope));
  });

  it('sends nothing without a scope, and nothing to your own server', async () => {
    const { seen, fetch } = rig();
    await run(new AiSdkClient(secrets, { fetch }), openai, {});
    expect(seen[0]?.body.prompt_cache_key).toBeUndefined();
    expect(cacheExtras({ ...openai, via: 'controller' }, scope)).toEqual({ options: {}, headers: {} });
  });
});

/** An OpenRouter stream: one word, served by `provider`, with `cached` prompt tokens read. */
const orStream = (provider: string, cached: number) =>
  new Response(
    [
      {
        id: '1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'deepseek/deepseek-v4-pro',
        provider,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }],
      },
      {
        id: '1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'deepseek/deepseek-v4-pro',
        provider,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
      {
        id: '1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'deepseek/deepseek-v4-pro',
        provider,
        choices: [],
        usage: {
          prompt_tokens: 3000,
          completion_tokens: 2,
          total_tokens: 3002,
          prompt_tokens_details: { cached_tokens: cached },
        },
      },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join('')
      .concat('data: [DONE]\n\n'),
    { headers: { 'content-type': 'text/event-stream' } },
  );

describe('OpenRouter', () => {
  const routing = async () => ({ provider: { require_parameters: true }, max_tokens: null });

  it('sends a session id, turns middle-out off, and pins the upstream once a call has warmed the cache', async () => {
    const { seen, fetch } = rig((n) => orStream('DeepInfra', n === 1 ? 0 : 2800));
    const client = new AiSdkClient(secrets, { fetch }, undefined, routing);
    await run(client, openrouter, { cache: scope });
    expect(seen[0]?.body.session_id).toBe(cacheKey(scope));
    expect(seen[0]?.body.transforms).toEqual([]);
    // The first call read nothing: no pin yet, the routing is the usual one.
    expect(seen[0]?.body.provider).toEqual({ require_parameters: true });
    // A second call reads 2800 tokens from the cache: the upstream is warm.
    await run(client, openrouter, { cache: scope });
    expect(seen[1]?.body.provider).toEqual({ require_parameters: true });
    const third = await run(client, openrouter, { cache: scope });
    expect(third.error).toBeUndefined();
    expect(seen[2]?.body.provider).toEqual({
      require_parameters: true,
      order: ['DeepInfra'],
      only: ['DeepInfra'],
      allow_fallbacks: false,
    });
    // Another branch is its own conversation: no pin.
    await run(client, openrouter, { cache: { ...scope, branch: 'msg_b' } });
    expect(seen[3]?.body.provider).toEqual({ require_parameters: true });
  });

  it('does not recompute its routing choice once pinned', async () => {
    const { fetch } = rig(() => orStream('DeepInfra', 2800));
    const route = vi.fn(routing);
    const client = new AiSdkClient(secrets, { fetch }, undefined, route);
    await run(client, openrouter, { cache: scope });
    await run(client, openrouter, { cache: scope });
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('drops the pin when the pinned upstream is down, asks again unpinned, and says it was a reset', async () => {
    const { seen, fetch } = rig((n) =>
      n === 1
        ? orStream('DeepInfra', 2800)
        : n === 2
          ? new Response('{"error":{"message":"No endpoints"}}', { status: 404 })
          : orStream('Together', 0),
    );
    const client = new AiSdkClient(secrets, { fetch }, undefined, routing);
    await run(client, openrouter, { cache: scope });
    const out = await run(client, openrouter, { cache: scope });
    expect(out.error).toBeUndefined();
    expect(seen).toHaveLength(3);
    expect(seen[1]?.body.provider).toMatchObject({ only: ['DeepInfra'], allow_fallbacks: false });
    expect(seen[2]?.body.provider).toEqual({ require_parameters: true });
    const finish = out.chunks.find((c) => c.type === 'finish');
    expect(finish).toMatchObject({ cacheReset: { reason: 'pinned_provider_failed', provider: 'DeepInfra' } });
    // And the pin is gone for the next call.
    expect(client.pins.get(`${cacheKey(scope)}:${openrouter.id}`)).toBeUndefined();
  });

  it('forgets a pin when the cache has gone cold', () => {
    let now = 0;
    const book = new PinBook(() => now, 600_000);
    book.set('k', { provider: 'X', routing: null });
    now = 599_000;
    expect(book.get('k')?.provider).toBe('X');
    now = 1_300_000;
    expect(book.get('k')).toBeUndefined();
  });

  it('asks Claude models behind it for automatic cache control', () => {
    const claude = model('openrouter', 'anthropic/claude-sonnet-5-5');
    expect(cacheExtras(claude, scope).options.openrouter?.cache_control).toEqual({ type: 'ephemeral' });
    expect(cacheExtras(openrouter, scope).options.openrouter?.cache_control).toBeUndefined();
  });

  it('puts that marker at the top level of the request body, as OpenRouter documents, and only for Claude', async () => {
    const claude = model('openrouter', 'anthropic/claude-sonnet-5-5');
    const { seen, fetch } = rig(() => orStream('Anthropic', 0));
    const client = new AiSdkClient(secrets, { fetch }, undefined, routing);
    await run(client, claude, { cache: scope });
    await run(client, openrouter, { cache: scope });
    expect(seen[0]?.body.cache_control).toEqual({ type: 'ephemeral' });
    expect(seen[1]?.body.cache_control).toBeUndefined();
  });
});

describe('a retry sends the same body', () => {
  it('after a short rate limit the Gateway asks the same model again with identical bytes', async () => {
    const { seen, fetch } = rig((n) =>
      n === 1
        ? new Response('{"error":{"type":"rate_limit_error","message":"slow down"}}', {
            status: 429,
            headers: { 'retry-after': '1' },
          })
        : new Response('{"error":{"message":"stop"}}', { status: 500 }),
    );
    const gateway = new Gateway({
      client: new AiSdkClient(secrets, { fetch }),
      sleep: async () => undefined,
    });
    const req: ModelRequest = {
      system: `${words(900)}\n\n${words(900)}`,
      systemBlocks: [words(900), words(900)],
      messages: turn(5),
      tools: TOOLS,
      toolChoice: 'auto',
      cache: scope,
    };
    try {
      for await (const _ of gateway.stream([anthropic], req, new AbortController().signal));
    } catch {
      // the second answer fails on purpose
    }
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[1]?.text).toBe(seen[0]?.text);
    expect(markers(seen[0]?.text ?? '')).toBeGreaterThan(0);
  });
});

describe('how long a cache lasts', () => {
  it('uses the shortest lifetime a profile lists, and says when it is a guess', () => {
    expect(warmWindow('anthropic')).toEqual({ ms: 5 * 60_000, assumed: false });
    expect(warmWindow('openai')).toEqual({ ms: 5 * 60_000, assumed: false });
    expect(warmWindow('deepseek')).toEqual({ ms: 60 * 60_000, assumed: true });
    expect(warmWindow('google').assumed).toBe(true);
    expect(warmWindow('mistral')).toEqual({ ms: 5 * 60_000, assumed: true });
  });
});
