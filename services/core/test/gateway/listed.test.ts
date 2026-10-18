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
