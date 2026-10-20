/**
 * ------------------------------------------------------------------
 *  Title    |  Testing a key without our model list getting in the way
 *  Ref      |  setup/routes.ts (liveTester, testFailed), setup/key-check.ts
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  A key is proved by the provider's own list where that list
 *           |  needs the key; models it does not offer stay off; and each
 *           |  failure is said in its own words, not as a connection problem.
 *  How      |  Fake JSON getters and a mock language model. Nothing here
 *           |  touches a network or a paid model.
 * ------------------------------------------------------------------
 */
import { AncileError, ModelConfig, type ProviderTestResponse } from '@nvx/contracts';
import { ClassifiedError } from '@nvx/resilience';
import { MockLanguageModelV2 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonGetter } from '../../src/models/watch/listers';
import { offeredBy } from '../../src/setup/key-check';
import { liveTester, testFailed } from '../../src/setup/routes';
import { fakeModel } from '../gateway/fake-provider';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const cfg = (provider: string, providerModel: string, price = 1, name = providerModel) =>
  ModelConfig.parse({
    ...fakeModel(providerModel, 'echo'),
    id: `${provider}/${providerModel}`,
    provider,
    provider_model: providerModel,
    display_name: name,
    price: { input_per_mtok: price, output_per_mtok: price },
    enabled: false,
  });

const http = (status: number, body = '') =>
  new ClassifiedError('permanent', `host answered ${status}`, { status, cause: { responseBody: body } });

/** A language model that answers, or throws what a provider's SDK would. */
const lm = (fail?: unknown) => async () =>
  new MockLanguageModelV2({
    doGenerate: async () => {
      if (fail) throw fail;
      return {
        content: [{ type: 'text', text: 'OK' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  });

const noNetwork: JsonGetter = async () => {
  throw new Error('no call expected');
};

describe('liveTester reads the provider list instead of spending a token', () => {
  it('Google: a good key is proved by the list, and a model it does not offer is reported', async () => {
    const urls: string[] = [];
    const get: JsonGetter = async (url, headers) => {
      urls.push(url);
      expect(headers['x-goog-api-key']).toBe('AQ.fake');
      return {
        models: [{ name: 'models/gemini-3.1-pro-preview', supportedGenerationMethods: ['generateContent'] }],
      };
    };
    // A language model that would fail the test if it were ever asked.
    const t = liveTester(lm(new Error('a token was spent')), get);
    const r = await t({
      provider: 'google',
      key: 'AQ.fake',
      model: cfg('google', 'gemini-3-pro'),
      models: [cfg('google', 'gemini-3-pro')],
    });
    expect(r.model).toBeNull();
    expect(r.offered).toEqual(['gemini-3.1-pro-preview']);
    expect(urls[0]).toContain('generativelanguage.googleapis.com/v1beta/models');
    const split = offeredBy(
      [cfg('google', 'gemini-3-pro'), cfg('google', 'gemini-3.1-pro-preview')],
      r.offered,
    );
    expect(split.missing.map((m) => m.provider_model)).toEqual(['gemini-3-pro']);
    expect(split.offered.map((m) => m.provider_model)).toEqual(['gemini-3.1-pro-preview']);
  });

  it('Google: a rejected key keeps the provider status and body, and reads as a rejected key', async () => {
    const get: JsonGetter = async () => {
      throw http(
        400,
        '{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"API key not valid.","details":[{"reason":"API_KEY_INVALID"}]}}',
      );
    };
    const err = await liveTester(lm(), get)({ provider: 'google', key: 'bad' }).catch((e) => e);
    expect(testFailed('google', err, 'bad').code).toBe('provider.auth_failed');
  });

  it('OpenRouter: a 401 from /key is a rejected key, and the public list is not used', async () => {
    const urls: string[] = [];
    const get: JsonGetter = async (url) => {
      urls.push(url);
      throw http(401, '{"error":{"message":"No auth credentials found","code":401}}');
    };
    const err = await liveTester(lm(), get)({ provider: 'openrouter', key: 'sk-or-v1-bad' }).catch((e) => e);
    expect(urls).toEqual(['https://openrouter.ai/api/v1/key']);
    expect(testFailed('openrouter', err, 'sk-or-v1-bad')).toMatchObject({
      code: 'provider.auth_failed',
      title: 'OpenRouter rejected the API key',
    });
  });

  it('OpenRouter: a good key passes with no configured model at all', async () => {
    const get: JsonGetter = async (url) => {
      expect(url).toBe('https://openrouter.ai/api/v1/key');
      return { data: { label: 'x' } };
    };
    await expect(liveTester(lm(), get)({ provider: 'openrouter', key: 'sk-or-v1-ok' })).resolves.toEqual({
      model: null,
    });
  });
});

describe('liveTester falls back to one token only where there is no trusted list', () => {
  it('uses a configured model the provider lists, not just the cheapest', async () => {
    const used: string[] = [];
    const t = liveTester(
      async (m) => {
        used.push(m.provider_model);
        return lm()();
      },
      async () => ({ data: [{ id: 'grok-b' }] }),
    );
    const r = await t({
      provider: 'xai',
      key: 'xai-k',
      model: cfg('xai', 'grok-a', 1),
      models: [cfg('xai', 'grok-a', 1), cfg('xai', 'grok-b', 2)],
    });
    expect(used).toEqual(['grok-b']);
    expect(r.model).toBe('xai/grok-b');
  });

  it('still tests with the cheapest model when the list cannot be read', async () => {
    const t = liveTester(lm(), async () => {
      throw http(404);
    });
    const r = await t({
      provider: 'xai',
      key: 'xai-k',
      model: cfg('xai', 'grok-a'),
      models: [cfg('xai', 'grok-a')],
    });
    expect(r.model).toBe('xai/grok-a');
  });

  it('a provider with no list and no configured model says so with its own code', async () => {
    const err = await liveTester(lm(), noNetwork)({ provider: 'zai', key: 'k' }).catch((e) => e);
    expect(err).toBeInstanceOf(AncileError);
    expect(testFailed('zai', err)).toMatchObject({ code: 'setup.no_test_model' });
  });
});

describe('testFailed says what happened', () => {
  it('names a real network failure as one', () => {
    const e = testFailed(
      'google',
      new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }),
    );
    expect(e.hint).toContain('Check your connection');
    const t = testFailed(
      'openai',
      Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }),
    );
    expect(t.hint).toContain('Check your connection');
  });

  it('calls a model that is not offered that, and says the key was not the problem', () => {
    const err = Object.assign(
      new Error(
        'models/gemini-3-pro is not found for API version v1beta, or is not supported for generateContent.',
      ),
      { statusCode: 404, triedModel: 'Gemini 3 Pro' },
    );
    const e = testFailed('google', err);
    expect(e.code).toBe('provider.model_not_offered');
    expect(e.title).toBe("Google accepted the key, but Gemini 3 Pro isn't offered to it");
    expect(e.hint).not.toContain('connection');
  });

  it('says a refusal is a refusal, not a connection problem', () => {
    const e = testFailed(
      'openai',
      Object.assign(new Error('Unsupported parameter: max_output_tokens'), { statusCode: 400 }),
    );
    expect(e.code).toBe('provider.unavailable');
    expect(e.title).toBe('OpenAI turned the test down');
    expect(e.hint).not.toContain('connection');
  });

  it('keeps rate limits as they were', () => {
    expect(testFailed('openai', Object.assign(new Error('slow down'), { statusCode: 429 })).title).toBe(
      'OpenAI is limiting requests right now',
    );
  });
});

describe('saving a key leaves off the models its list does not offer', () => {
  it('enables the offered model, reports the other, and still saves the key', async () => {
    const good = { ...cfg('google', 'gemini-3.1-pro-preview'), display_name: 'Gemini 3.1 Pro' };
    const bad = { ...cfg('google', 'gemini-3-pro'), display_name: 'Gemini 3 Pro' };
    h = await harness({
      models: [good, bad],
      taskClasses: { 'chat.default': ['google/gemini-3.1-pro-preview'] },
      tester: async () => ({ model: null, offered: ['gemini-3.1-pro-preview'] }),
    });
    const r = await h.call<ProviderTestResponse>('POST', '/setup/providers/test', {
      provider: 'google',
      key: 'AQ.fake',
    });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toEqual(['google/gemini-3.1-pro-preview']);
    expect(r.body.not_offered).toEqual([{ id: 'google/gemini-3-pro', display_name: 'Gemini 3 Pro' }]);
    expect(await h.secrets.get('GOOGLE_GENERATIVE_AI_API_KEY')).toBe('AQ.fake');
  });

  it('OpenRouter with no configured models succeeds', async () => {
    h = await harness({ tester: async () => ({ model: null }) });
    const r = await h.call<ProviderTestResponse>('POST', '/setup/providers/test', {
      provider: 'openrouter',
      key: 'sk-or-v1-ok',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ model: null, enabled: [], not_offered: [] });
  });
});
