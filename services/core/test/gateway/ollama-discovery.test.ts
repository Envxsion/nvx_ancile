/**
 * Ollama-detected models (docs/models.md, Ollama): a chat model pulled into
 * Ollama is listed by itself as ollama/<name>, never an embedding model and
 * never twice; it leaves when Ollama no longer has it. A configured Ollama
 * model answers only once Ollama has said it has it, and a slow or silent
 * Ollama keeps what it said last.
 */
import type { ModelConfig } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import {
  DISCOVERED_CONTEXT,
  discoveredId,
  discoveredModel,
  isChatModel,
  type OllamaModelFacts,
  servedByOllama,
} from '../../src/gateway/ollama-discovery';
import { ModelRegistry } from '../../src/gateway/registry';
import { MemorySecretStore, SecretBox } from '../../src/secrets';
import { MemorySettings } from '../../src/settings';

const configured = (p: Partial<ModelConfig> & Pick<ModelConfig, 'id' | 'provider_model'>): ModelConfig => ({
  provider: 'ollama',
  display_name: p.id,
  via: 'direct',
  family: 'qwen',
  context_window: 40_960,
  max_output: 8_192,
  capabilities: ['tools', 'json'],
  price: { input_per_mtok: 0, output_per_mtok: 0 },
  enabled: true,
  ...p,
});

const QWEN = configured({ id: 'ollama/qwen3-14b', provider_model: 'qwen3:14b' });

/** A registry whose Ollama lists `tags.now` (null: not answering; a throw: down). */
function world(
  o: {
    models?: ModelConfig[];
    tags?: string[] | null | 'down';
    facts?: Record<string, OllamaModelFacts>;
    probe?: boolean;
  } = {},
) {
  const tags = { now: o.tags === undefined ? [] : o.tags, asked: 0 };
  const facts = { asked: [] as string[] };
  const settings = new MemorySettings();
  const registry = new ModelRegistry({
    models: o.models ?? [QWEN],
    taskClasses: { 'chat.default': ['ollama/qwen3-14b'] },
    secrets: new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64'))),
    settings,
    offline: false,
    ...(o.probe !== false && {
      ollamaTags: async () => {
        tags.asked++;
        if (tags.now === 'down') throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
        return tags.now;
      },
    }),
    ...(o.facts && {
      ollamaFacts: async (name: string) => {
        facts.asked.push(name);
        return o.facts?.[name] ?? null;
      },
    }),
  });
  const status = () => Object.fromEntries(registry.info().map((m) => [m.id, m.status]));
  return { registry, tags, facts, settings, status };
}

describe('Ollama-detected models', () => {
  it('lists each pulled chat model as ollama/<name>, ready, and never an embedding model', async () => {
    const w = world({
      tags: ['llama3.2:latest', 'qwen3:14b', 'nomic-embed-text:latest', 'mxbai-embed-large', 'bge-m3:567m'],
    });
    await w.registry.refresh();
    expect(w.status()).toEqual({ 'ollama/qwen3-14b': 'ready', 'ollama/llama3.2': 'ready' });
    const found = w.registry.get('ollama/llama3.2');
    expect(found).toMatchObject({
      provider: 'ollama',
      provider_model: 'llama3.2:latest',
      display_name: 'llama3.2 (Ollama)',
      via: 'direct',
      family: 'llama',
      context_window: DISCOVERED_CONTEXT,
      capabilities: [],
      enabled: true,
    });
    expect(w.registry.isDiscovered('ollama/llama3.2')).toBe(true);
    expect(w.registry.isDiscovered('ollama/qwen3-14b')).toBe(false);
    expect(w.registry.isCustom('ollama/llama3.2')).toBe(false);
    // Chosen by name, it answers.
    expect(w.registry.chain('chat.default', 'ollama/llama3.2').map((m) => m.id)).toEqual([
      'ollama/llama3.2',
      'ollama/qwen3-14b',
    ]);
  });

  it('a model Ollama no longer has leaves the list, and a configured one reads Not pulled', async () => {
    const w = world({ tags: ['llama3.2:latest', 'qwen3:14b'] });
    await w.registry.refresh();
    w.tags.now = ['gemma3:4b'];
    await w.registry.refreshOllama();
    expect(w.status()).toEqual({ 'ollama/qwen3-14b': 'not_pulled', 'ollama/gemma3:4b': 'ready' });
    expect(w.registry.get('ollama/llama3.2')).toBeUndefined();
    expect(() => w.registry.chain('chat.default')).toThrow(/No enabled model/);
    w.tags.now = [];
    await w.registry.refreshOllama();
    expect(w.status()).toEqual({ 'ollama/qwen3-14b': 'not_pulled' });
  });

  it('until Ollama has answered once, a configured Ollama model is not offered', async () => {
    const down = world({ tags: 'down' });
    await down.registry.refresh();
    expect(down.status()).toEqual({ 'ollama/qwen3-14b': 'not_pulled' });
    const silent = world({ tags: null });
    await silent.registry.refresh();
    expect(silent.status()).toEqual({ 'ollama/qwen3-14b': 'not_pulled' });
    // Ollama starts: the next look finds it.
    down.tags.now = ['qwen3:14b'];
    await down.registry.refreshOllama();
    expect(down.status()).toEqual({ 'ollama/qwen3-14b': 'ready' });
  });

  it('an Ollama that stops answering keeps what it said last, instead of emptying the list', async () => {
    const w = world({ tags: ['llama3.2:3b'] });
    await w.registry.refresh();
    w.tags.now = 'down';
    await w.registry.refreshOllama();
    expect(w.status()).toEqual({ 'ollama/qwen3-14b': 'not_pulled', 'ollama/llama3.2:3b': 'ready' });
    w.tags.now = null;
    await w.registry.refreshOllama();
    expect(w.registry.get('ollama/llama3.2:3b')).toBeDefined();
  });

  it('without an Ollama probe (tests, no Ollama wired), configured models keep their switch', async () => {
    const w = world({ probe: false });
    await w.registry.refresh();
    expect(w.status()).toEqual({ 'ollama/qwen3-14b': 'ready' });
  });

  it('never lists a name a configured or added model already serves, whatever its shape', async () => {
    const old = configured({
      id: 'ollama/qwen3-14b',
      provider: 'openai-compatible',
      provider_model: 'qwen3:14b',
      base_url: 'http://localhost:11434/v1',
    });
    const lan = configured({
      id: 'endpoint-lan/llama3.2',
      provider: 'endpoint-lan',
      provider_model: 'llama3.2',
      base_url: 'http://192.168.1.20:11434/v1',
    });
    const off = configured({ id: 'ollama/gemma3', provider_model: 'gemma3:4b', enabled: false });
    const w = world({ models: [old, lan, off], tags: ['qwen3:14b', 'llama3.2:latest', 'gemma3:4b'] });
    await w.registry.refresh();
    expect(w.registry.all().map((m) => m.id)).toEqual([
      'ollama/qwen3-14b',
      'endpoint-lan/llama3.2',
      'ollama/gemma3',
    ]);
    // A model on a GPU node is the node's, not this Ollama's.
    expect(servedByOllama({ id: 'node/qwen3:14b', provider: 'node', via: 'controller' })).toBe(false);
  });

  it('a model you add under the same id wins, and the found one comes back when you remove it', async () => {
    const w = world({ models: [], tags: ['qwen3:8b'] });
    await w.registry.refresh();
    expect(w.registry.isDiscovered('ollama/qwen3:8b')).toBe(true);
    const added = configured({
      id: 'ollama/qwen3:8b',
      provider_model: 'qwen3:8b',
      display_name: 'Qwen3 8B (Ollama)',
    });
    await w.registry.saveCustom([added]);
    expect(w.registry.all().filter((m) => m.id === 'ollama/qwen3:8b')).toHaveLength(1);
    expect(w.registry.get('ollama/qwen3:8b')).toMatchObject({
      display_name: 'Qwen3 8B (Ollama)',
      capabilities: ['tools', 'json'],
    });
    expect(w.registry.isCustom('ollama/qwen3:8b')).toBe(true);
    expect(w.registry.isDiscovered('ollama/qwen3:8b')).toBe(false);
    await w.registry.saveCustom([]);
    expect(w.registry.isDiscovered('ollama/qwen3:8b')).toBe(true);
    expect(w.registry.get('ollama/qwen3:8b')?.display_name).toBe('qwen3:8b (Ollama)');
  });

  it('one you turn off stays off, also after Ollama is asked again', async () => {
    const w = world({ models: [], tags: ['llama3.2:3b'] });
    await w.registry.refresh();
    await w.registry.setEnabled({ 'ollama/llama3.2:3b': false });
    w.tags.now = ['llama3.2:3b', 'qwen3:8b'];
    await w.registry.refreshOllama();
    await w.registry.refresh();
    expect(w.status()).toEqual({ 'ollama/llama3.2:3b': 'disabled', 'ollama/qwen3:8b': 'ready' });
  });

  it("takes Ollama's own word on what a model can do, asked once per pulled name", async () => {
    const w = world({
      models: [],
      tags: ['qwen3:8b', 'gemma3:4b', 'my-embedder:latest', 'nomic-embed-text:latest'],
      facts: {
        'qwen3:8b': { capabilities: ['completion', 'tools', 'thinking'], context: 40_960 },
        'gemma3:4b': { capabilities: ['completion', 'vision'], context: 131_072 },
        // Says embedding: never listed, whatever its name.
        'my-embedder:latest': { capabilities: ['embedding'], context: 8_192 },
      },
    });
    await w.registry.refresh();
    expect(w.registry.get('ollama/qwen3:8b')).toMatchObject({
      capabilities: ['tools', 'reasoning'],
      context_window: 40_960,
      max_output: 8_192,
    });
    expect(w.registry.get('ollama/gemma3:4b')).toMatchObject({
      capabilities: ['vision'],
      context_window: 131_072,
    });
    expect(w.registry.all().map((m) => m.id)).toEqual(['ollama/qwen3:8b', 'ollama/gemma3:4b']);
    await w.registry.refreshOllama();
    // nomic-embed-text said nothing, so it is asked again; the others are known.
    expect(w.facts.asked).toEqual([
      'qwen3:8b',
      'gemma3:4b',
      'my-embedder:latest',
      'nomic-embed-text:latest',
      'nomic-embed-text:latest',
    ]);
  });

  it('asks Ollama at most every 30 seconds, and at once after a pull', async () => {
    const w = world({ tags: ['qwen3:14b'] });
    await w.registry.refresh();
    await w.registry.refresh();
    expect(w.tags.asked).toBe(1);
    await w.registry.refreshOllama();
    expect(w.tags.asked).toBe(2);
  });
});

describe('what a pulled name becomes', () => {
  it('tells chat models from embedding models by name when Ollama does not say', () => {
    for (const n of [
      'qwen3:14b',
      'llama3.2:latest',
      'gemma3:4b',
      'deepseek-r1:8b',
      'qwen2.5-coder:7b',
      'gpt-oss:20b',
    ])
      expect(isChatModel(n, null)).toBe(true);
    for (const n of [
      'nomic-embed-text:latest',
      'mxbai-embed-large:335m',
      'all-minilm:22m',
      'bge-m3:567m',
      'snowflake-arctic-embed2:568m',
      'granite-embedding:278m',
      'paraphrase-multilingual:278m',
      'jeffh/intfloat-multilingual-e5-large:f16',
    ])
      expect(isChatModel(n, null)).toBe(false);
    // Ollama's word wins over the name.
    expect(isChatModel('embed-chat:1b', { capabilities: ['completion'], context: null })).toBe(true);
  });

  it('makes a valid id from any name Ollama lists, the one a one-click download saves', () => {
    expect(discoveredId('qwen3:8b')).toBe('ollama/qwen3:8b');
    expect(discoveredId('llama3.2')).toBe('ollama/llama3.2');
    expect(discoveredId('llama3.2:latest')).toBe('ollama/llama3.2');
    const hf = discoveredModel('hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M', null);
    expect(hf).toMatchObject({
      id: 'ollama/hf.co-bartowski-Llama-3.2-3B-Instruct-GGUF:Q4_K_M',
      provider_model: 'hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M',
      family: 'llama',
    });
    // A small window stays small; an odd one falls back to the default.
    expect(discoveredModel('tiny:1b', { capabilities: null, context: 2_048 })).toMatchObject({
      context_window: 2_048,
      max_output: 2_048,
    });
    expect(discoveredModel('odd:1b', { capabilities: null, context: -1 })?.context_window).toBe(
      DISCOVERED_CONTEXT,
    );
  });
});
