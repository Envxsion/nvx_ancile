/**
 * ------------------------------------------------------------------
 *  Title    |  Reasoning effort per provider (EN1)
 *  Ref      |  ROADMAP.md EN1 · PV3 · CA2 · docs/prompt-caching.md
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  Which models take an effort (and so show the chip), what
 *           |  the request carries for each provider under its own
 *           |  option name, that a model which ignores effort gets
 *           |  nothing, and that effort is a request setting: it is not
 *           |  part of the prompt, so it cannot break the cached start.
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';
import { describe, expect, it, vi } from 'vitest';
import { effortLevels, effortOptions } from '../../src/gateway/effort';
import { ollamaChat } from '../../src/gateway/ollama-chat';
import { AiSdkClient } from '../../src/gateway/providers';
import { ModelRegistry } from '../../src/gateway/registry';
import type { ModelRequest, StreamChunk } from '../../src/gateway/types';
import { MemorySecretStore, SecretBox } from '../../src/secrets';
import { MemorySettings } from '../../src/settings';

const base = {
  via: 'direct' as const,
  family: 'test',
  context_window: 200_000,
  max_output: 8_000,
  price: { input_per_mtok: 1, output_per_mtok: 2 },
  enabled: true,
};
const model = (
  provider: string,
  provider_model: string,
  capabilities: ModelConfig['capabilities'] = ['tools', 'reasoning'],
  extra: Partial<ModelConfig> = {},
): ModelConfig =>
  ({
    ...base,
    id: `${provider}/${provider_model}`,
    provider,
    provider_model,
    display_name: provider_model,
    capabilities,
    ...extra,
  }) as ModelConfig;

const anthropic = model('anthropic', 'claude-sonnet-5-5', undefined, {
  base_url: 'http://anthropic.test/v1',
});
const openai = model('openai', 'gpt-5.6', undefined, { base_url: 'http://openai.test/v1' });
const google = model('google', 'gemini-3.5-flash');
const google25 = model('google', 'gemini-2.5-pro');
const openrouter = model('openrouter', 'deepseek/deepseek-v4-pro');
const xaiMini = model('xai', 'grok-3-mini');
const xaiBig = model('xai', 'grok-4.7');
const gptOss = model('ollama', 'gpt-oss:20b');
const qwenLocal = model('ollama', 'qwen3:8b');
const deepseek = model('deepseek', 'deepseek-reasoner', undefined, { base_url: 'http://deepseek.test/v1' });

describe('which models take an effort', () => {
  it('lists the levels of a reasoning model on a provider that takes one', () => {
    for (const m of [anthropic, openai, google, google25, openrouter, gptOss])
      expect(effortLevels(m), m.id).toEqual(['low', 'medium', 'high']);
  });

  it('gives xAI’s small reasoning models low and high only, and leaves the rest without a chip', () => {
    expect(effortLevels(xaiMini)).toEqual(['low', 'high']);
    expect(effortLevels(xaiBig)).toEqual([]);
  });

  it('shows no chip for a model that does not reason, a provider with no effort option, or a model that only thinks or not', () => {
    expect(effortLevels(model('anthropic', 'claude-haiku-4-5', ['tools']))).toEqual([]);
    expect(effortLevels(deepseek)).toEqual([]);
    expect(effortLevels(qwenLocal)).toEqual([]);
    expect(effortLevels(model('openai', 'gpt-4o', ['tools', 'reasoning']))).toEqual([]);
    expect(effortLevels(model('node', 'qwen3', ['tools', 'reasoning'], { via: 'controller' }))).toEqual([]);
  });
});

describe('what the request carries', () => {
  it('uses each provider’s own option name', () => {
    expect(effortOptions(anthropic, 'high').options).toEqual({ anthropic: { effort: 'high' } });
    expect(effortOptions(openai, 'low').options).toEqual({ openai: { reasoningEffort: 'low' } });
    expect(effortOptions(openrouter, 'medium').options).toEqual({
      openrouter: { reasoning: { effort: 'medium' } },
    });
    expect(effortOptions(xaiMini, 'high').options).toEqual({ xai: { reasoningEffort: 'high' } });
  });

  it('gives Gemini 3 a named level and Gemini 2.5 a thinking budget', () => {
    expect(effortOptions(google, 'medium').options).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'medium' } },
    });
    expect(effortOptions(google25, 'low').options).toEqual({
      google: { thinkingConfig: { thinkingBudget: 1_024 } },
    });
    expect(effortOptions(google25, 'high').options).toEqual({
      google: { thinkingConfig: { thinkingBudget: 24_576 } },
    });
  });

  it('gives Ollama a think level, for gpt-oss only', () => {
    expect(effortOptions(gptOss, 'high')).toEqual({ options: {}, think: 'high' });
    expect(effortOptions(qwenLocal, 'high')).toEqual({ options: {} });
  });

  it('sends nothing for no effort, a model that takes none, or a level it does not take', () => {
    expect(effortOptions(anthropic, undefined)).toEqual({ options: {} });
    expect(effortOptions(deepseek, 'high')).toEqual({ options: {} });
    expect(effortOptions(xaiMini, 'medium')).toEqual({ options: {} });
  });
});

/* ---- on the wire -------------------------------------------------------------- */

const secrets = { get: async () => 'test-key' };
const user = [{ role: 'user' as const, content: 'hello there' }];

function rig() {
  const seen: { url: string; body: Record<string, unknown>; text: string }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(init?.body ?? '');
    seen.push({ url: String(url), body: JSON.parse(text || '{}'), text });
    return new Response('{"error":{"message":"stop"}}', { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  return { seen, fetch };
}

async function wire(m: ModelConfig, req: Partial<ModelRequest>) {
  const { seen, fetch } = rig();
  const client = new AiSdkClient(secrets, { fetch });
  try {
    for await (const _ of client.stream(m, { messages: user, ...req }, new AbortController().signal));
  } catch {
    /* the rig answers 500: only the request matters */
  }
  return seen[0];
}

describe('on the wire', () => {
  it('Anthropic gets the effort as a request setting', async () => {
    const seen = await wire(anthropic, { effort: 'high' });
    expect(seen?.text).toMatch(/"effort":"high"/);
  });

  it('OpenAI gets reasoning effort', async () => {
    const seen = await wire(openai, { effort: 'low' });
    expect(seen?.text).toMatch(/"(reasoning_effort|effort)":"low"/);
  });

  it('OpenRouter gets reasoning.effort in the body', async () => {
    const seen = await wire(openrouter, { effort: 'medium' });
    expect(seen?.body.reasoning).toEqual({ effort: 'medium' });
  });

  it('xAI gets reasoning_effort for a mini model, and none for the others', async () => {
    const w = await wire(xaiMini, { effort: 'low' });
    expect(w?.body.reasoning_effort).toBe('low');
    expect((await wire(xaiBig, { effort: 'low' }))?.text).not.toMatch(/effort/);
  });

  it('Google gets a thinking level', async () => {
    const seen = await wire(google, { effort: 'high' });
    expect(seen?.text).toMatch(/"thinkingLevel":"high"/);
  });

  it('a model that takes no effort gets none, whatever was asked', async () => {
    const seen = await wire(deepseek, { effort: 'high' });
    expect(seen?.text).not.toMatch(/effort/);
    expect(seen?.text).not.toMatch(/"reasoning"/);
  });

  it('no effort asked, none sent', async () => {
    const seen = await wire(anthropic, {});
    expect(seen?.text).not.toMatch(/effort/);
  });

  it('Ollama gets think with the level for gpt-oss, and nothing for other models', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response('{"error":"stop"}', { status: 500 });
    }) as unknown as typeof globalThis.fetch;
    const drain = async (m: ModelConfig) => {
      const out: StreamChunk[] = [];
      try {
        for await (const c of ollamaChat(
          m,
          { messages: user, effort: 'high' },
          new AbortController().signal,
          {
            baseUrl: 'http://ollama.test',
            fetch,
          },
        ))
          out.push(c);
      } catch {
        /* the rig answers 500 */
      }
    };
    await drain(gptOss);
    await drain(qwenLocal);
    expect(bodies[0]?.think).toBe('high');
    expect(bodies[1]).not.toHaveProperty('think');
  });

  it('is not part of the prompt: the same messages, system and tools go out with and without it', async () => {
    const tools = [{ name: 'a_tool', description: 'x', inputSchema: { type: 'object', properties: {} } }];
    const req = { system: 'You are helpful.', messages: user, tools, toolChoice: 'auto' as const };
    const plain = await wire(anthropic, req);
    const high = await wire(anthropic, { ...req, effort: 'high' });
    const strip = (b: Record<string, unknown>) => {
      const { output_config: _o, effort: _e, ...rest } = b;
      return JSON.stringify(rest);
    };
    // Everything that makes up the cached start is byte-identical; only the effort setting differs.
    expect(strip(high?.body ?? {})).toBe(strip(plain?.body ?? {}));
  });
});

describe('what Core tells the Cockpit', () => {
  it('lists the efforts of each model in GET /models, so the chip shows for the right ones', async () => {
    const registry = new ModelRegistry({
      models: [anthropic, model('anthropic', 'claude-haiku-4-5', ['tools']), deepseek, xaiMini],
      taskClasses: { 'chat.default': [anthropic.id] },
      secrets: new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64'))),
      settings: new MemorySettings(),
      offline: false,
    });
    await registry.refresh();
    const levels = Object.fromEntries(registry.info().map((m) => [m.id, m.effort_levels]));
    expect(levels['anthropic/claude-sonnet-5-5']).toEqual(['low', 'medium', 'high']);
    expect(levels['anthropic/claude-haiku-4-5']).toBeUndefined();
    expect(levels['deepseek/deepseek-reasoner']).toBeUndefined();
    expect(levels['xai/grok-3-mini']).toEqual(['low', 'high']);
  });
});
