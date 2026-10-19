/**
 * Only what is real is listed (Settings → Models): a cloud model once its
 * provider's key is saved, an Ollama model once pulled, a node model from
 * config once switched on, and every model you added yourself.
 */
import type { ModelConfig } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { ModelRegistry } from '../../src/gateway/registry';
import { MemorySecretStore, SecretBox } from '../../src/secrets';
import { MemorySettings } from '../../src/settings';

const model = (p: Partial<ModelConfig> & Pick<ModelConfig, 'id' | 'provider'>): ModelConfig => ({
  provider_model: p.id.split('/')[1] ?? p.id,
  display_name: p.id,
  via: 'direct',
  family: 'claude',
  context_window: 200_000,
  max_output: 8_192,
  capabilities: ['tools', 'json'],
  price: { input_per_mtok: 1, output_per_mtok: 5 },
  enabled: true,
  ...p,
});

const MODELS = [
  model({ id: 'anthropic/claude-sonnet-5-5', provider: 'anthropic' }),
  model({ id: 'openai/gpt-5.5', provider: 'openai', enabled: false }),
  model({ id: 'controller/qwen3-72b', provider: 'controller', via: 'controller', enabled: false }),
  model({ id: 'ollama/qwen3-14b', provider: 'ollama', provider_model: 'qwen3:14b' }),
  model({ id: 'ollama/llama3.2', provider: 'ollama', provider_model: 'llama3.2' }),
];

async function world(keys: string[] = [], pulled: string[] = []) {
  const secrets = new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64')));
  for (const k of keys) await secrets.set(k, 'test-value');
  const registry = new ModelRegistry({
    models: MODELS,
    taskClasses: { 'chat.default': ['anthropic/claude-sonnet-5-5'] },
    secrets,
    settings: new MemorySettings(),
    offline: false,
    ollamaTags: async () => pulled,
  });
  await registry.refresh();
  const listed = () =>
    registry
      .info()
      .filter((m) => m.listed && !m.alias_of)
      .map((m) => m.id);
  return { registry, listed };
}

describe('listed models', () => {
  it('lists no cloud, node or unpulled model on a fresh install', async () => {
    const w = await world();
    expect(w.listed()).toEqual([]);
    // Routing and traces still find them by id, with what they need.
    expect(w.registry.info().find((m) => m.id === 'anthropic/claude-sonnet-5-5')?.status).toBe('needs_key');
  });

  it("lists a provider's models once its key is saved, switched off or not", async () => {
    const w = await world(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    expect(w.listed()).toEqual(['anthropic/claude-sonnet-5-5', 'openai/gpt-5.5']);
  });

  it('lists an Ollama model once Ollama has it', async () => {
    const w = await world([], ['qwen3:14b']);
    expect(w.listed()).toEqual(['ollama/qwen3-14b']);
  });

  it('lists a node model from config once it is switched on', async () => {
    const w = await world();
    await w.registry.setEnabled({ 'controller/qwen3-72b': true });
    expect(w.listed()).toEqual(['controller/qwen3-72b']);
  });
});

/** MD2: a provider starts with three current models of different tiers; "Add more models" shows the rest. */
describe('starter models (MD2)', () => {
  const cloud = [
    model({ id: 'anthropic/claude-opus-5-5', provider: 'anthropic', provider_model: 'claude-opus-5-5' }),
    model({ id: 'anthropic/claude-sonnet-5-5', provider: 'anthropic', provider_model: 'claude-sonnet-5-5' }),
    model({ id: 'anthropic/claude-haiku-4-5', provider: 'anthropic', provider_model: 'claude-haiku-4-5' }),
    model({ id: 'anthropic/claude-sonnet-4-5', provider: 'anthropic', provider_model: 'claude-sonnet-4-5' }),
    model({ id: 'anthropic/claude-opus-4-1', provider: 'anthropic', provider_model: 'claude-opus-4-1' }),
  ];
  const price = (i: number) => ({ input_per_mtok: i, output_per_mtok: i * 4 });
  const unlined = [1, 2, 3, 4, 5].map((i) =>
    model({
      id: `qwen/q${i}`,
      provider: 'qwen',
      provider_model: `q${i}`,
      family: 'qwen',
      price: price(i),
      secret: 'QWEN_API_KEY',
    }),
  );

  async function setup(keys: string[], models: ModelConfig[]) {
    const secrets = new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64')));
    for (const k of keys) await secrets.set(k, 'test-value');
    const registry = new ModelRegistry({
      models,
      taskClasses: { 'chat.default': [models[0]?.id ?? ''] },
      secrets,
      settings: new MemorySettings(),
      offline: false,
    });
    await registry.refresh();
    const info = () => new Map(registry.info().map((m) => [m.id, m]));
    return { registry, info };
  }

  it('lists one current model of each tier, and says the others are "more"', async () => {
    const w = await setup(['ANTHROPIC_API_KEY'], cloud);
    const info = w.info();
    const listed = [...info.values()].filter((m) => m.listed && !m.alias_of).map((m) => m.id);
    expect(listed.length).toBe(3);
    expect(listed).toEqual(
      expect.arrayContaining([
        'anthropic/claude-opus-5-5',
        'anthropic/claude-sonnet-5-5',
        'anthropic/claude-haiku-4-5',
      ]),
    );
    expect(info.get('anthropic/claude-sonnet-4-5')?.unlisted_reason).toBe('more');
  });

  it('with no key, nothing of the provider is listed and the reason is the key', async () => {
    const w = await setup([], cloud);
    expect(w.info().get('anthropic/claude-opus-5-5')).toMatchObject({
      listed: false,
      unlisted_reason: 'no_key',
    });
  });

  it('ranks a provider without lines by price: dearest best, middle balanced, cheapest fast', async () => {
    const w = await setup(['QWEN_API_KEY'], unlined);
    const listed = [...w.info().values()].filter((m) => m.listed && !m.alias_of).map((m) => m.id);
    expect(listed.sort()).toEqual(['qwen/q1', 'qwen/q3', 'qwen/q5']);
  });

  it('"Add more models" shows one more, and hiding takes a starter away', async () => {
    const w = await setup(['ANTHROPIC_API_KEY'], cloud);
    await w.registry.setShown('anthropic/claude-sonnet-4-5', true);
    await w.registry.setShown('anthropic/claude-haiku-4-5', false);
    const info = w.info();
    expect(info.get('anthropic/claude-sonnet-4-5')?.listed).toBe(true);
    expect(info.get('anthropic/claude-haiku-4-5')).toMatchObject({ listed: false, unlisted_reason: 'more' });
  });

  it('removing the key hides the provider again', async () => {
    const w = await setup(['ANTHROPIC_API_KEY'], cloud);
    await w.registry.setShown('anthropic/claude-sonnet-4-5', true);
    // A new registry over an empty store stands for the key being removed.
    const gone = await setup([], cloud);
    expect([...gone.info().values()].some((m) => m.listed)).toBe(false);
    expect(w.info().get('anthropic/claude-sonnet-4-5')?.listed).toBe(true);
  });

  it('shows Claude Code models only while it is signed in', async () => {
    const cc = [model({ id: 'claude_code/sonnet', provider: 'claude_code', family: 'claude' })];
    const w = await setup([], cc);
    expect(w.info().get('claude_code/sonnet')?.unlisted_reason).toBe('signed_out');
    w.registry.setClaudeAuth({ signed_in: true } as never);
    expect(w.info().get('claude_code/sonnet')?.listed).toBe(true);
  });
});
