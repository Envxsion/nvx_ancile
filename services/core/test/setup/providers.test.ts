/**
 * ------------------------------------------------------------------
 *  Title    |  First-class providers: keys, regions, GET /providers (PV1)
 *  Ref      |  credentials/routes.ts, setup/routes.ts, gateway/profiles.ts
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  DeepSeek, Kimi, MiniMax, GLM, Qwen, xAI and Mistral keys
 *           |  save like the first four, with a region kept beside the
 *           |  key where the provider has regions, and the Cockpit can
 *           |  list every provider without hard-coding it.
 * ------------------------------------------------------------------
 */

import type { CredentialList, CredentialStatus, ProviderInfo } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeModel } from '../gateway/fake-provider';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const model = (provider: string, id = provider) => ({
  ...fakeModel(id, 'echo'),
  id: `${provider}/${id}`,
  provider,
  display_name: `${provider} model`,
  enabled: false,
});

const KIMI = 'sk-kimi-test-key-0001';

describe('GET /providers', () => {
  it('lists every provider with its regions, key hint and key page, and no key', async () => {
    h = await harness();
    const r = await h.call<{ items: ProviderInfo[] }>('GET', '/providers');
    expect(r.status).toBe(200);
    const ids = r.body.items.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'anthropic',
        'deepseek',
        'moonshot',
        'minimax',
        'qwen',
        'zai',
        'xai',
        'mistral',
        'generic',
      ]),
    );
    const moonshot = r.body.items.find((p) => p.id === 'moonshot');
    expect(moonshot).toMatchObject({
      name: 'Moonshot (Kimi)',
      default_region: 'global',
      credential_id: 'moonshot',
      has_models_list: true,
      docs_url: expect.stringContaining('platform.kimi.ai'),
      key_hint: expect.stringContaining('sk-'),
    });
    expect(moonshot?.regions?.map((x) => x.id)).toEqual(['global', 'china']);
    expect(r.body.items.find((p) => p.id === 'zai')?.has_models_list).toBe(false);
    expect(r.body.items.find((p) => p.id === 'deepseek')?.regions).toBeNull();
  });
});

describe('saving a key for a new provider', () => {
  it('lists the new rows with their environment variable, and none set', async () => {
    h = await harness();
    const r = await h.call<CredentialList>('GET', '/credentials');
    const row = (id: string) => r.body.items.find((x) => x.id === id);
    expect(row('deepseek')).toMatchObject({ set: false, env_var: 'DEEPSEEK_API_KEY', check: 'provider' });
    expect(row('qwen')).toMatchObject({ env_var: 'DASHSCOPE_API_KEY', region_env_var: 'DASHSCOPE_REGION' });
    expect(row('moonshot')?.region_env_var).toBe('MOONSHOT_REGION');
    expect(row('xai')?.region_env_var).toBeUndefined();
  });

  it('tests the key in the region named, then keeps the key, the region and switches the models on', async () => {
    const seen: (string | undefined)[] = [];
    h = await harness({
      models: [model('moonshot', 'kimi-k3')],
      tester: async ({ region }) => {
        seen.push(region);
        return { model: 'moonshot/kimi-k3' };
      },
    });
    const add = await h.call<CredentialStatus>('PUT', '/credentials/moonshot', {
      value: KIMI,
      region: 'china',
    });
    expect(add.status).toBe(200);
    expect(add.body).toMatchObject({ id: 'moonshot', set: true, source: 'saved', region: 'china' });
    expect(JSON.stringify(add.body)).not.toContain(KIMI);
    expect(seen).toEqual(['china']);
    expect(await h.secrets.get('MOONSHOT_API_KEY')).toBe(KIMI);
    expect(await h.secrets.get('MOONSHOT_REGION')).toBe('china');

    // A new key without a region goes back to the default: the saved one goes.
    const again = await h.call<CredentialStatus>('PUT', '/credentials/moonshot', { value: `${KIMI}2` });
    expect(again.body.region).toBeNull();
    expect(await h.secrets.get('MOONSHOT_REGION')).toBeUndefined();

    await h.call('PUT', '/credentials/moonshot', { value: KIMI, region: 'china' });
    await h.call('DELETE', '/credentials/moonshot');
    expect(await h.secrets.get('MOONSHOT_API_KEY')).toBeUndefined();
    expect(await h.secrets.get('MOONSHOT_REGION')).toBeUndefined();
  });

  it('refuses a region the provider does not have, and saves nothing', async () => {
    h = await harness({ models: [model('moonshot', 'kimi-k3')] });
    const r = await h.call<{ error: { code: string; hint: string } }>('PUT', '/credentials/moonshot', {
      value: KIMI,
      region: 'mars',
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('request.invalid');
    expect(r.body.error.hint).toContain('global, china');
    expect(await h.secrets.get('MOONSHOT_API_KEY')).toBeUndefined();
  });

  it('ignores a region for a provider that has none', async () => {
    h = await harness({
      models: [model('deepseek', 'deepseek-flash')],
      tester: async () => ({ model: 'x' }),
    });
    const r = await h.call<CredentialStatus>('PUT', '/credentials/deepseek', {
      value: 'sk-deepseek-key-0001',
      region: 'china',
    });
    expect(r.status).toBe(200);
    expect(r.body.region).toBeUndefined();
  });

  it('says a key is out of credit, not rejected, and saves nothing', async () => {
    h = await harness({
      models: [model('deepseek', 'deepseek-flash')],
      tester: async () => {
        throw Object.assign(new Error('Insufficient Balance'), {
          statusCode: 402,
          responseBody: JSON.stringify({
            error: { message: 'Insufficient Balance', code: 'invalid_request_error' },
          }),
        });
      },
    });
    const r = await h.call<{ error: { code: string; title: string; hint: string } }>(
      'PUT',
      '/credentials/deepseek',
      { value: 'sk-deepseek-key-0001' },
    );
    expect(r.body.error).toMatchObject({
      code: 'provider.no_credit',
      title: 'DeepSeek says your account is out of credit',
      hint: 'Top up at DeepSeek, or pick another model.',
    });
    expect(await h.secrets.get('DEEPSEEK_API_KEY')).toBeUndefined();
  });

  it('says a key for the other region is for the other region', async () => {
    h = await harness({
      models: [model('qwen', 'qwen-plus')],
      tester: async () => {
        throw Object.assign(new Error('Invalid API-key provided.'), {
          statusCode: 401,
          responseBody: JSON.stringify({ code: 'InvalidApiKey', message: 'Invalid API-key provided.' }),
        });
      },
    });
    const r = await h.call<{ error: { code: string; hint: string } }>('PUT', '/credentials/qwen', {
      value: 'sk-qwen-key-0001',
      region: 'singapore',
    });
    expect(r.body.error.code).toBe('provider.auth_failed');
    expect(r.body.error.hint).toContain('China (Beijing)');
  });
});

describe('what the key looks like', () => {
  it('refuses an Anthropic admin key, which cannot send a message', async () => {
    h = await harness({ models: [model('anthropic', 'claude-test')] });
    const r = await h.call<{ error: { code: string; title: string } }>('PUT', '/credentials/anthropic', {
      value: 'sk-ant-admin01-abcdef123456',
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('credentials.invalid');
    expect(r.body.error.title).toContain('admin');
  });

  it("refuses a key that is plainly another provider's", async () => {
    h = await harness({ models: [model('openai', 'gpt-test')] });
    const r = await h.call<{ error: { code: string; title: string } }>('PUT', '/credentials/openai', {
      value: 'sk-ant-api03-abcdef123456',
    });
    expect(r.status).toBe(400);
    expect(r.body.error.title).toBe('That key is for Anthropic, not OpenAI');
    expect(await h.secrets.get('OPENAI_API_KEY')).toBeUndefined();
  });
});

describe('a saved key starts the first model check (F3a) and leaves a preview off (F3b)', () => {
  const gmodel = (id: string, provider_model: string) => ({
    ...model('google', id),
    provider_model,
    secret: 'GOOGLE_GENERATIVE_AI_API_KEY',
  });
  const KEY = 'AIzaSy-test-key-0000000000000000001';

  it("setup calls onKeySaved only when the key is saved, and switches on each line's stable model", async () => {
    const saved: string[] = [];
    h = await harness({
      offline: false,
      models: [
        gmodel('flash', 'gemini-3.8-flash'),
        gmodel('flash-next', 'gemini-4.0-flash-preview-1001'),
        gmodel('pro', 'gemini-3.1-pro-preview'),
      ],
      onKeySaved: (p) => saved.push(p),
    });
    await h.call('POST', '/setup/providers/test', { provider: 'google', key: KEY, save: false });
    expect(saved).toEqual([]);
    const r = await h.call<{ enabled: string[] }>('POST', '/setup/providers/test', {
      provider: 'google',
      key: KEY,
      save: true,
    });
    expect(saved).toEqual(['google']);
    // Flash has a stable model, so its preview stays off; Pro has only a preview, so that comes on.
    expect(r.body.enabled).toEqual(['google/flash', 'google/pro']);
  });
});
