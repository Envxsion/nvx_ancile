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
