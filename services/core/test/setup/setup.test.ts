/**
 * Onboarding with no file editing: a key is tested live (here, by an
 * injected tester), stored encrypted, its models switch on, a preset is
 * chosen. Plus the model list and drafts.
 */
import type { ModelInfo, SetupStatus } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeModel } from '../gateway/fake-provider';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const claude = {
  ...fakeModel('c', 'echo'),
  id: 'anthropic/claude-test',
  provider: 'anthropic',
  display_name: 'Claude Test',
  enabled: false,
};

describe('onboarding', () => {
  it('starts incomplete, with the offline model offered', async () => {
    h = await harness();
    const s = (await h.call<SetupStatus>('GET', '/setup')).body;
    expect(s.complete).toBe(false);
    expect(s.offline_model).toBe(true);
    expect(s.providers.find((p) => p.id === 'anthropic')).toMatchObject({
      configured: false,
      needs_key: true,
    });
  });

  it('stores a key only after it passes, and switches on that provider', async () => {
    h = await harness({ models: [claude], taskClasses: { 'chat.default': ['anthropic/claude-test'] } });
    const r = await h.call<{ ok: boolean; enabled: string[] }>('POST', '/setup/providers/test', {
      provider: 'anthropic',
      key: ' sk-ant-test ',
    });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toEqual(['anthropic/claude-test']);
    expect(await h.secrets.get('ANTHROPIC_API_KEY')).toBe('sk-ant-test');
    const models = (await h.call<{ items: ModelInfo[] }>('GET', '/models')).body.items;
    expect(models.find((m) => m.id === 'anthropic/claude-test')?.status).toBe('ready');
  });

  it('tests the saved key again (a new region) without the key ever being sent back', async () => {
    h = await harness({ models: [claude], taskClasses: { 'chat.default': ['anthropic/claude-test'] } });
    await h.secrets.set('ANTHROPIC_API_KEY', 'sk-ant-saved');
    const r = await h.call<Record<string, unknown>>('POST', '/setup/providers/test', {
      provider: 'anthropic',
      use_saved: true,
    });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('sk-ant-saved');
    expect(await h.secrets.get('ANTHROPIC_API_KEY')).toBe('sk-ant-saved');
  });

  it('asks for a key when there is none saved to test', async () => {
    h = await harness({ models: [claude] });
    const r = await h.call<{ error: { title: string } }>('POST', '/setup/providers/test', {
      provider: 'anthropic',
      use_saved: true,
    });
    expect(r.status).toBe(400);
    expect(r.body.error.title).toBe('Paste a key to test');
  });

  it('switches on only the Ollama models Ollama has, and never offers one it has not pulled', async () => {
    const ollama = (name: string, enabled: boolean) => ({
      ...fakeModel(name, 'echo'),
      id: `ollama/${name}`,
      provider: 'ollama',
      provider_model: name,
      display_name: name,
      enabled,
    });
    h = await harness({
      models: [ollama('qwen3:14b', true), ollama('llama3.2:3b', false), ollama('gemma3:4b', false)],
      taskClasses: { 'chat.default': ['ollama/qwen3:14b', 'ollama/llama3.2:3b'] },
      offline: false,
      ollamaTags: async () => ['llama3.2:3b', 'nomic-embed-text:latest'],
      tester: async () => ({ model: 'llama3.2:3b', available: ['llama3.2:3b', 'nomic-embed-text:latest'] }),
    });
    const r = await h.call<{ enabled: string[] }>('POST', '/setup/providers/test', { provider: 'ollama' });
    expect(r.body.enabled).toEqual(['ollama/llama3.2:3b']);
    const items = (await h.call<{ items: ModelInfo[] }>('GET', '/models')).body.items;
    const status = Object.fromEntries(items.map((m) => [m.id, m.status]));
    expect(status).toEqual({
      'ollama/qwen3:14b': 'not_pulled',
      'ollama/llama3.2:3b': 'ready',
      'ollama/gemma3:4b': 'disabled',
    });
    // A chain never starts with a model Ollama does not have.
    expect(h.registry.chain('chat.default').map((m) => m.id)).toEqual(['ollama/llama3.2:3b']);
  });

  it('never switches on a configured Ollama model Ollama has not pulled, even one with its own address', async () => {
    // The shape config/models.yaml used to ship: an OpenAI-compatible entry on Ollama's port.
    const onPort = {
      ...fakeModel('qwen3-14b', 'echo'),
      id: 'ollama/qwen3-14b',
      provider: 'openai-compatible',
      provider_model: 'qwen3:14b',
      display_name: 'Qwen3 14B (Ollama)',
      base_url: 'http://localhost:11434/v1',
      enabled: false,
    };
    h = await harness({
      models: [onPort],
      offline: false,
      ollamaTags: async () => ['llama3.2:3b'],
      tester: async () => ({ model: 'llama3.2:3b', available: ['llama3.2:3b'] }),
    });
    const r = await h.call<{ enabled: string[] }>('POST', '/setup/providers/test', { provider: 'ollama' });
    // Only what Ollama has: the model it lists by itself.
    expect(r.body.enabled).toEqual(['ollama/llama3.2:3b']);
    const items = (await h.call<{ items: ModelInfo[] }>('GET', '/models')).body.items;
    expect(Object.fromEntries(items.map((m) => [m.id, m.status]))).toEqual({
      'ollama/qwen3-14b': 'disabled',
      'ollama/llama3.2:3b': 'ready',
    });
  });

  it('finds the chat models Ollama has by itself, and Ollama reads set up only once one can answer', async () => {
    const tags: { now: string[] | null } = { now: null };
    const configured = {
      ...fakeModel('qwen3-14b', 'echo'),
      id: 'ollama/qwen3-14b',
      provider: 'ollama',
      provider_model: 'qwen3:14b',
      enabled: true,
    };
    h = await harness({
      models: [configured],
      offline: false,
      ollamaTags: async () => tags.now,
      tester: async () => ({ model: 'qwen3:8b', available: tags.now ?? [] }),
    });
    // Switched on in the file, but Ollama has not answered: not set up, not offered.
    const before = (await h.call<SetupStatus>('GET', '/setup')).body;
    expect(before.providers.find((p) => p.id === 'ollama')?.configured).toBe(false);
    expect(
      (await h.call<{ items: ModelInfo[] }>('GET', '/models')).body.items.map((m) => [m.id, m.status]),
    ).toEqual([['ollama/qwen3-14b', 'not_pulled']]);

    tags.now = ['qwen3:8b', 'nomic-embed-text:latest'];
    const r = await h.call<{ enabled: string[] }>('POST', '/setup/providers/test', { provider: 'ollama' });
    expect(r.body.enabled).toEqual(['ollama/qwen3:8b']);
    const after = (await h.call<SetupStatus>('GET', '/setup')).body;
    expect(after.providers.find((p) => p.id === 'ollama')?.configured).toBe(true);
    const items = (await h.call<{ items: ModelInfo[] }>('GET', '/models')).body.items;
    expect(items.map((m) => [m.id, m.status, m.provider])).toEqual([
      ['ollama/qwen3-14b', 'not_pulled', 'ollama'],
      ['ollama/qwen3:8b', 'ready', 'ollama'],
    ]);
  });

  it('explains a rejected key and stores nothing', async () => {
    h = await harness({
      models: [claude],
      tester: async () => {
        throw Object.assign(new Error('401 invalid x-api-key'), { status: 401 });
      },
    });
    const r = await h.call<{ error: { code: string; title: string } }>('POST', '/setup/providers/test', {
      provider: 'anthropic',
      key: 'bad',
    });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('provider.auth_failed');
    expect(r.body.error.title).toBe('Anthropic rejected the API key');
    expect(await h.secrets.get('ANTHROPIC_API_KEY')).toBeUndefined();
  });

  it('asks for a key before testing a provider that needs one', async () => {
    h = await harness();
    const r = await h.call<{ error: { title: string } }>('POST', '/setup/providers/test', {
      provider: 'openai',
    });
    expect(r.status).toBe(400);
    expect(r.body.error.title).toBe('Paste a key to test');
  });

  it('completes with a preset', async () => {
    h = await harness();
    const r = await h.call<SetupStatus>('POST', '/setup/complete', { preset: 'careful' });
    expect(r.body).toMatchObject({ complete: true, preset: 'careful' });
  });

  it('lists models with why they cannot answer', async () => {
    h = await harness({ models: [claude] });
    const items = (await h.call<{ items: ModelInfo[] }>('GET', '/models')).body.items;
    expect(items.find((m) => m.id === 'anthropic/claude-test')).toMatchObject({
      status: 'disabled',
      secret: 'ANTHROPIC_API_KEY',
      offline: false,
    });
    expect(items.find((m) => m.id === 'offline/test')).toMatchObject({ status: 'ready', offline: true });
  });
});

describe('drafts and UI state', () => {
  it('keeps a draft per thread and reply, and deletes it when emptied', async () => {
    h = await harness();
    await h.call('PUT', '/drafts/thr_1/_', { text: 'half a thought' });
    expect((await h.call<{ text: string }>('GET', '/drafts/thr_1/_')).body.text).toBe('half a thought');
    await h.call('PUT', '/drafts/thr_1/_', { text: '' });
    expect((await h.call<{ text: string }>('GET', '/drafts/thr_1/_')).body.text).toBe('');
  });

  it('round-trips opaque UI state and rejects odd keys', async () => {
    h = await harness();
    await h.call('PUT', '/ui-state/scroll.thr_1', { value: { top: 420 } });
    expect((await h.call<{ value: unknown }>('GET', '/ui-state/scroll.thr_1')).body.value).toEqual({
      top: 420,
    });
    expect((await h.call('GET', '/ui-state/a%20b')).status).toBe(400);
    // null forgets the key (back to the client's defaults); it used to fail in Postgres.
    expect((await h.call('PUT', '/ui-state/scroll.thr_1', { value: null })).status).toBe(200);
    expect((await h.call<{ value: unknown }>('GET', '/ui-state/scroll.thr_1')).body.value).toBeNull();
  });
});
