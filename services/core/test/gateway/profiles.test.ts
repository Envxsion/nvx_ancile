/**
 * ------------------------------------------------------------------
 *  Title    |  Provider profiles, on recorded error and usage shapes
 *  Ref      |  roadmap PV3, GW1 · gateway/profiles.ts, provider-errors.ts
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  Every provider's errors and usage objects differ. These
 *           |  fixtures are hand-written in the shapes the providers'
 *           |  own docs show (researched 16-17 Oct 2026), one or more
 *           |  per provider, and pin what the table makes of them: the
 *           |  kind of trouble, the key's shape, and where cache hits
 *           |  are read from.
 *  Note     |  A fixture marked UNCONFIRMED stands for a signal the
 *           |  research could not confirm; the test then also pins
 *           |  that it is never read as proof of a bad key.
 * ------------------------------------------------------------------
 */

import { describe, expect, it } from 'vitest';
import {
  baseUrlFor,
  DEFAULT_SECRET,
  FIRST_CLASS_IDS,
  isRegion,
  knownProfile,
  PROFILES,
  profileFor,
  providerInfo,
  recogniseKey,
} from '../../src/gateway/profiles';
import {
  classifyFailure,
  classifyProviderError,
  type ProviderErrorResult,
  readBody,
} from '../../src/gateway/provider-errors';
import { cacheFromRaw } from '../../src/gateway/usage';

const NOW = Date.parse('2026-10-19T10:00:00Z');

/** What the profile of `provider` makes of a failed call. */
const kindOf = (
  provider: string,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): ProviderErrorResult => classifyProviderError(profileFor(provider), status, body, headers, NOW);

const err = (code: string, message: string, type = 'error') => ({ error: { code, message, type } });

describe('the table', () => {
  it('has a profile for every provider the brief names, and a generic one', () => {
    const ids = PROFILES.map((p) => p.id);
    for (const id of [
      'anthropic',
      'openai',
      'google',
      'openrouter',
      'deepseek',
      'moonshot',
      'minimax',
      'qwen',
      'zai',
      'xai',
      'mistral',
      'groq',
      'together',
      'fireworks',
      'cerebras',
      'cloudflare',
      'perplexity',
      'cohere',
      'ollama',
      'generic',
    ])
      expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names the default secret for each first-class provider', () => {
    expect(DEFAULT_SECRET).toMatchObject({
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      google: 'GOOGLE_GENERATIVE_AI_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
      deepseek: 'DEEPSEEK_API_KEY',
      moonshot: 'MOONSHOT_API_KEY',
      minimax: 'MINIMAX_API_KEY',
      zai: 'ZAI_API_KEY',
      qwen: 'DASHSCOPE_API_KEY',
      xai: 'XAI_API_KEY',
      mistral: 'MISTRAL_API_KEY',
    });
    for (const id of FIRST_CLASS_IDS) expect(knownProfile(id)?.secret).toBeTruthy();
  });

  it('keeps regions where keys are bound to one, with a default, and an address for each', () => {
    for (const id of ['moonshot', 'minimax', 'qwen', 'zai']) {
      const p = profileFor(id);
      expect(p.regions?.length).toBeGreaterThanOrEqual(2);
      expect(p.regionSecret).toBeTruthy();
      expect(isRegion(p, p.defaultRegion as string)).toBe(true);
      for (const r of p.regions ?? []) expect(baseUrlFor(p, r.id)).toBe(r.baseUrl);
    }
    expect(baseUrlFor(profileFor('moonshot'))).toBe('https://api.moonshot.ai/v1');
    expect(baseUrlFor(profileFor('moonshot'), 'china')).toBe('https://api.moonshot.cn/v1');
    // An unknown region falls back to the default rather than a wrong address.
    expect(baseUrlFor(profileFor('moonshot'), 'mars')).toBe('https://api.moonshot.ai/v1');
    expect(baseUrlFor(profileFor('minimax'), 'china')).toBe('https://api.minimax.cn/v1');
    expect(baseUrlFor(profileFor('qwen'))).toContain('dashscope-intl');
    expect(baseUrlFor(profileFor('qwen'), 'beijing')).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    expect(baseUrlFor(profileFor('zai'), 'china')).toContain('bigmodel.cn');
    expect(baseUrlFor(profileFor('deepseek'))).toBe('https://api.deepseek.com');
    expect(baseUrlFor(profileFor('xai'))).toBe('https://api.x.ai/v1');
    // Cloudflare needs your account ID: no address of its own.
    expect(baseUrlFor(profileFor('cloudflare'))).toBeNull();
  });

  it('gives Z.ai no models list and the rest one', () => {
    expect(profileFor('zai').modelsPath).toBeNull();
    expect(profileFor('deepseek').modelsPath).toBe('/models');
    expect(providerInfo(profileFor('zai')).has_models_list).toBe(false);
  });

  it('describes a provider to the Cockpit without any key', () => {
    expect(providerInfo(profileFor('moonshot'))).toMatchObject({
      id: 'moonshot',
      name: 'Moonshot (Kimi)',
      default_region: 'global',
      credential_id: 'moonshot',
      needs_key: true,
      has_models_list: true,
      regions: [
        { id: 'global', label: expect.any(String) },
        { id: 'china', label: expect.any(String) },
      ],
    });
    expect(providerInfo(profileFor('groq')).credential_id).toBeNull();
    expect(providerInfo(profileFor('ollama')).needs_key).toBe(false);
    expect(JSON.stringify(PROFILES.map(providerInfo))).not.toMatch(/baseUrl|errors|regionSecret/);
  });

  it('treats a name it does not know as the generic endpoint, and local servers as one profile', () => {
    expect(profileFor('some-new-host').id).toBe('generic');
    expect(profileFor('vllm').id).toBe('ollama');
    expect(profileFor('lmstudio').id).toBe('ollama');
    expect(knownProfile('some-new-host')).toBeUndefined();
  });
});

describe('recogniseKey', () => {
  it('reads Anthropic keys by kind, and never returns the key', () => {
    const ws = recogniseKey('sk-ant-api03-AbCdEf');
    expect(ws).toEqual({ provider: 'anthropic', kind: 'workspace', usable: true, confirmed: true });
    expect(recogniseKey('sk-ant-usr-xyz')).toMatchObject({ provider: 'anthropic', kind: 'personal' });
    expect(recogniseKey('sk-ant-admin01-xyz')).toMatchObject({ kind: 'admin', usable: false });
    expect(JSON.stringify(ws)).not.toContain('AbCdEf');
  });

  it('reads OpenAI project, service-account and admin keys, and a bare sk- only when told the provider', () => {
    expect(recogniseKey('sk-proj-abc')).toMatchObject({ provider: 'openai', kind: 'project' });
    expect(recogniseKey('sk-svcacct-abc')).toMatchObject({ provider: 'openai', kind: 'service_account' });
    expect(recogniseKey('sk-admin-abc')).toMatchObject({ provider: 'openai', kind: 'admin', usable: false });
    // sk- is OpenAI's legacy shape, DeepSeek's, Moonshot's and Qwen's: not guessed.
    expect(recogniseKey('sk-abcdef0123')).toBeNull();
    expect(recogniseKey('sk-abcdef0123', 'openai')).toMatchObject({ provider: 'openai', kind: 'legacy' });
    expect(recogniseKey('sk-abcdef0123', 'deepseek')).toMatchObject({
      provider: 'deepseek',
      kind: 'standard',
    });
    // The longer, more specific prefix wins over sk-.
    expect(recogniseKey('sk-ant-api03-x', 'openai')).toMatchObject({ provider: 'anthropic' });
  });

  it('reads the other providers whose shape is their own', () => {
    expect(recogniseKey('AIzaSyA-1234567890')).toMatchObject({ provider: 'google', kind: 'standard' });
    // The newer AI Studio key shape comes from community threads: recognised, not confirmed.
    expect(recogniseKey('AQ.Ab8RN6Jxyz')).toMatchObject({
      provider: 'google',
      kind: 'auth',
      confirmed: false,
    });
    expect(recogniseKey('sk-or-v1-0123abcd')).toMatchObject({ provider: 'openrouter', confirmed: false });
    expect(recogniseKey('xai-0123abcd')).toMatchObject({ provider: 'xai' });
    expect(recogniseKey('gsk_0123abcd')).toMatchObject({ provider: 'groq' });
    expect(recogniseKey('csk-0123abcd')).toMatchObject({ provider: 'cerebras' });
    expect(recogniseKey('fw_0123abcd')).toMatchObject({ provider: 'fireworks' });
    expect(recogniseKey('pplx-0123abcd')).toMatchObject({ provider: 'perplexity' });
  });

  it('returns null for what it cannot place', () => {
    expect(recogniseKey('')).toBeNull();
    expect(recogniseKey('not a key')).toBeNull();
    expect(recogniseKey('0123456789abcdef0123456789abcdef')).toBeNull();
    // A Mistral key has no prefix: only recognised when the provider is named.
    expect(recogniseKey('0123456789abcdef0123456789abcdef', 'mistral')).toMatchObject({
      provider: 'mistral',
    });
  });
});

describe('Anthropic errors', () => {
  it('401 authentication_error is a bad key', () => {
    expect(
      kindOf('anthropic', 401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
        request_id: 'req_011',
      }).kind,
    ).toBe('bad_key');
  });
  it('402 billing_error and the credit-balance 400 are no credit', () => {
    expect(
      kindOf('anthropic', 402, { type: 'error', error: { type: 'billing_error', message: 'Payment issue.' } })
        .kind,
    ).toBe('no_credit');
    expect(
      kindOf('anthropic', 400, {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message:
            'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.',
        },
      }).kind,
    ).toBe('no_credit');
    // An ordinary 400 is not.
    expect(
      kindOf('anthropic', 400, {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'messages.0.role: Input should be user or assistant',
        },
      }).kind,
    ).toBe('invalid_request');
  });
  it('a spend cap on a 429 without Retry-After is no credit, a plain rate limit waits', () => {
    expect(
      kindOf('anthropic', 429, {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'You have reached your monthly spend limit.' },
      }).kind,
    ).toBe('no_credit');
    const limited = kindOf(
      'anthropic',
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens exceeded.' } },
      { 'retry-after': '7' },
    );
    expect(limited).toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000 });
  });
  it('403 permission_error is a model the key may not use, never a bad key', () => {
    expect(
      kindOf('anthropic', 403, {
        type: 'error',
        error: {
          type: 'permission_error',
          message: 'Your API key does not have permission to use the specified resource.',
        },
      }).kind,
    ).toBe('model_not_permitted');
  });
  it('an unscoped personal key is a request problem on any status (AK1)', () => {
    const message =
      'This API key is not scoped to a workspace. Requests must include the anthropic-workspace-id header.';
    for (const status of [400, 401, 403])
      expect(
        kindOf('anthropic', status, { type: 'error', error: { type: 'invalid_request_error', message } })
          .kind,
      ).toBe('invalid_request');
  });
  it('529 is overloaded, 500 is a server error', () => {
    expect(
      kindOf('anthropic', 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
        .kind,
    ).toBe('overloaded');
    expect(
      kindOf('anthropic', 500, { type: 'error', error: { type: 'api_error', message: 'Internal' } }).kind,
    ).toBe('server');
  });
});

describe('OpenAI errors', () => {
  it.each([
    'credit_balance_exhausted',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded',
    'insufficient_quota',
  ])('429 %s is no credit, not a rate limit', (code) => {
    expect(
      kindOf('openai', 429, err(code, 'You exceeded your current quota.', 'insufficient_quota')).kind,
    ).toBe('no_credit');
  });
  it('another 429 is a rate limit that honours a Retry-After date', () => {
    const r = kindOf(
      'openai',
      429,
      err(
        'rate_limit_exceeded',
        'Rate limit reached for gpt-5.5 in organization org-x on requests per min.',
        'requests',
      ),
      { 'retry-after': new Date(NOW + 5000).toUTCString() },
    );
    expect(r.kind).toBe('rate_limited');
    expect(r.retryAfterMs).toBe(5000);
  });
  it('401 Incorrect API key is a bad key; a region block is a region', () => {
    expect(
      kindOf(
        'openai',
        401,
        err('invalid_api_key', 'Incorrect API key provided: sk-proj-********abcd.', 'invalid_request_error'),
      ).kind,
    ).toBe('bad_key');
    expect(
      kindOf(
        'openai',
        403,
        err('unsupported_country_region_territory', 'Country, region, or territory not supported'),
      ).kind,
    ).toBe('region');
  });
  it('503 server_is_overloaded is overloaded', () => {
    expect(kindOf('openai', 503, err('server_is_overloaded', 'The server is overloaded')).kind).toBe(
      'overloaded',
    );
  });
});

describe('Google errors', () => {
  it('402 is depleted prepay credit', () => {
    expect(
      kindOf('google', 402, {
        error: { code: 402, message: 'Your prepayment credits are depleted.', status: 'FAILED_PRECONDITION' },
      }).kind,
    ).toBe('no_credit');
  });
  it('429 RESOURCE_EXHAUSTED is a rate limit', () => {
    expect(
      kindOf('google', 429, {
        error: {
          code: 429,
          message: 'Resource has been exhausted (e.g. check quota).',
          status: 'RESOURCE_EXHAUSTED',
        },
      }).kind,
    ).toBe('rate_limited');
  });
  it('UNCONFIRMED: 400 API_KEY_INVALID is suspected, never proof of a bad key', () => {
    const r = kindOf('google', 400, {
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
      },
    });
    expect(r.kind).toBe('invalid_request');
    expect(r.suspectBadKey).toBe(true);
  });
  it('UNCONFIRMED: 400 FAILED_PRECONDITION about location is a region', () => {
    expect(
      kindOf('google', 400, {
        error: {
          code: 400,
          message: 'User location is not supported for the API use.',
          status: 'FAILED_PRECONDITION',
        },
      }).kind,
    ).toBe('region');
  });
  it('403 asking for an API key is a bad key', () => {
    expect(
      kindOf('google', 403, {
        error: {
          code: 403,
          message: "Method doesn't allow unregistered callers. Please use API Key.",
          status: 'PERMISSION_DENIED',
        },
      }).kind,
    ).toBe('bad_key');
  });
});

describe('OpenRouter errors', () => {
  it('402 is no credit; 401 is a bad key; 429 a rate limit; 403 moderation is the request', () => {
    expect(
      kindOf('openrouter', 402, {
        error: { code: 402, message: 'Insufficient credits. Add more using https://openrouter.ai/credits' },
      }).kind,
    ).toBe('no_credit');
    expect(
      kindOf('openrouter', 401, { error: { code: 401, message: 'No auth credentials found' } }).kind,
    ).toBe('bad_key');
    expect(kindOf('openrouter', 429, { error: { code: 429, message: 'Rate limit exceeded' } }).kind).toBe(
      'rate_limited',
    );
    expect(
      kindOf('openrouter', 403, {
        error: { code: 403, message: 'Your chosen model requires moderation and your input was flagged' },
      }).kind,
    ).toBe('invalid_request');
  });
});

describe('DeepSeek errors', () => {
  it('402 Insufficient Balance is no credit', () => {
    expect(
      kindOf('deepseek', 402, err('invalid_request_error', 'Insufficient Balance', 'unknown_error')).kind,
    ).toBe('no_credit');
  });
  it('401 is a bad key, 429 a rate limit, 503 overloaded, 422 the request', () => {
    expect(
      kindOf(
        'deepseek',
        401,
        err('invalid_request_error', 'Authentication Fails (no such user)', 'authentication_error'),
      ).kind,
    ).toBe('bad_key');
    expect(
      kindOf('deepseek', 429, err('rate_limit_reached', 'Rate Limit Reached', 'rate_limit_error')).kind,
    ).toBe('rate_limited');
    expect(kindOf('deepseek', 503, err('server_overloaded', 'Server Overloaded', 'server_error')).kind).toBe(
      'overloaded',
    );
    expect(kindOf('deepseek', 422, err('invalid_request_error', 'Invalid Parameters')).kind).toBe(
      'invalid_request',
    );
  });
});

describe('Moonshot (Kimi) errors', () => {
  it('429 exceeded_current_quota_error is no credit; the others are limits', () => {
    expect(
      kindOf(
        'moonshot',
        429,
        err('', 'Your account is suspended due to insufficient balance', 'exceeded_current_quota_error'),
      ).kind,
    ).toBe('no_credit');
    expect(
      kindOf('moonshot', 429, err('', 'Your account reached max concurrency', 'rate_limit_reached_error'))
        .kind,
    ).toBe('rate_limited');
    expect(
      kindOf('moonshot', 429, err('', 'The engine is currently overloaded', 'engine_overloaded_error')).kind,
    ).toBe('overloaded');
  });
  it('401 is a bad key that may be the other region', () => {
    const r = kindOf('moonshot', 401, err('', 'Invalid Authentication', 'invalid_authentication_error'));
    expect(r).toMatchObject({ kind: 'bad_key', regionHint: true });
  });
  it('UNCONFIRMED: 404 not found or permission denied is a model the key may not use', () => {
    expect(
      kindOf(
        'moonshot',
        404,
        err('', 'Not found the model kimi-k3 or Permission denied', 'resource_not_found_error'),
      ).kind,
    ).toBe('model_not_permitted');
  });
});

describe('MiniMax errors', () => {
  it('HTTP 200 with base_resp 1008 or 2056 is no credit', () => {
    expect(
      kindOf('minimax', 200, { base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }).kind,
    ).toBe('no_credit');
    expect(
      kindOf('minimax', 200, { base_resp: { status_code: 2056, status_msg: 'usage limit exceeded' } }).kind,
    ).toBe('no_credit');
  });
  it('1002 is a rate limit', () => {
    expect(kindOf('minimax', 200, { base_resp: { status_code: 1002, status_msg: 'rate limit' } }).kind).toBe(
      'rate_limited',
    );
  });
  it('UNCONFIRMED: 2049 on a 200 is not a bad key; on a 401 it is, with a region hint', () => {
    const body = { base_resp: { status_code: 2049, status_msg: 'invalid api key' } };
    expect(kindOf('minimax', 200, body)).toMatchObject({ kind: 'invalid_request', suspectBadKey: true });
    expect(kindOf('minimax', 401, body)).toMatchObject({
      kind: 'bad_key',
      regionHint: true,
      confirmed: false,
    });
  });
  it('a successful body (status_code 0) is no error', () => {
    expect(kindOf('minimax', 200, { base_resp: { status_code: 0, status_msg: 'success' } }).kind).toBe(
      'unknown',
    );
  });
});

describe('Qwen (Model Studio) errors', () => {
  it('400 Arrearage and 403 AllocationQuota.FreeTierOnly are no credit', () => {
    expect(
      kindOf('qwen', 400, {
        code: 'Arrearage',
        message: 'Access denied, please make sure your account is in good standing.',
        request_id: 'r1',
      }).kind,
    ).toBe('no_credit');
    expect(
      kindOf('qwen', 403, {
        code: 'AllocationQuota.FreeTierOnly',
        message: 'The free tier of the model has been exhausted.',
        request_id: 'r2',
      }).kind,
    ).toBe('no_credit');
  });
  it('401 InvalidApiKey is a bad key with a region hint; a body that names the region says region', () => {
    expect(
      kindOf('qwen', 401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.', request_id: 'r3' }),
    ).toMatchObject({
      kind: 'bad_key',
      regionHint: true,
    });
    expect(
      kindOf(
        'qwen',
        401,
        err(
          'invalid_api_key',
          'Incorrect API key provided. This key is for the China (mainland) site; use the international endpoint.',
          'invalid_request_error',
        ),
      ).kind,
    ).toBe('region');
  });
  it('429 Throttling.* is a rate limit; 403 Model.AccessDenied a model not permitted', () => {
    expect(
      kindOf('qwen', 429, { code: 'Throttling.RateQuota', message: 'Requests rate limit exceeded' }).kind,
    ).toBe('rate_limited');
    expect(kindOf('qwen', 403, { code: 'Model.AccessDenied', message: 'Model access denied.' }).kind).toBe(
      'model_not_permitted',
    );
  });
});

describe('Z.ai (GLM) errors', () => {
  it('429 with 1113 is no credit while 1302 is a rate limit: the code, not the status, decides', () => {
    expect(
      kindOf('zai', 429, {
        error: { code: '1113', message: 'Insufficient balance or no resource package. Please recharge.' },
      }).kind,
    ).toBe('no_credit');
    expect(
      kindOf('zai', 429, {
        error: {
          code: '1308',
          message: 'Usage limit reached for 5 hour. Your limit will reset at 2026-10-19 12:00:00',
        },
      }).kind,
    ).toBe('no_credit');
    expect(
      kindOf('zai', 429, { error: { code: '1302', message: 'Rate limit reached for requests' } }).kind,
    ).toBe('rate_limited');
    expect(
      kindOf('zai', 429, { error: { code: '1305', message: 'The service may be temporarily overloaded' } })
        .kind,
    ).toBe('overloaded');
  });
  it('1311 is a plan that does not include the model, still on a 429', () => {
    expect(
      kindOf('zai', 429, {
        error: { code: '1311', message: 'Your subscription plan does not include glm-5.3' },
      }).kind,
    ).toBe('model_not_permitted');
  });
  it('401 with a code is a bad key; 403 1220 is no access to the API', () => {
    expect(kindOf('zai', 401, { error: { code: '1000', message: 'Authentication failed' } }).kind).toBe(
      'bad_key',
    );
    expect(
      kindOf('zai', 403, {
        error: { code: '1220', message: 'You do not have permission to access the specified API' },
      }).kind,
    ).toBe('model_not_permitted');
  });
});

describe('xAI errors', () => {
  it('UNCONFIRMED: a 403 about credits is no credit, never a bad key', () => {
    expect(
      kindOf('xai', 403, {
        code: 'The caller does not have permission to execute the specified operation',
        error: "Your newly created team doesn't have any credits yet. Purchase them on the console.",
      }).kind,
    ).toBe('no_credit');
  });
  it('401 is a bad key; UNCONFIRMED: a 400 saying incorrect key is only suspected', () => {
    expect(
      kindOf('xai', 401, { code: 'Unauthorized', error: 'Incorrect API key provided: xai-****.' }).kind,
    ).toBe('bad_key');
    expect(
      kindOf('xai', 400, {
        code: 'Client specified an invalid argument',
        error: 'Incorrect API key provided: xai-****.',
      }),
    ).toMatchObject({
      kind: 'invalid_request',
      suspectBadKey: true,
    });
  });
});

describe('Mistral errors', () => {
  it('401 Unauthorized is a bad key; 429 a rate limit', () => {
    expect(kindOf('mistral', 401, { message: 'Unauthorized', request_id: 'abc' }).kind).toBe('bad_key');
    expect(
      kindOf('mistral', 429, {
        object: 'error',
        message: 'Rate limit exceeded',
        type: 'rate_limited',
        code: '1300',
      }).kind,
    ).toBe('rate_limited');
  });
});

describe('Groq, Together, Fireworks, Cerebras errors', () => {
  it('Groq: 498 flex capacity is overloaded; 401 invalid key; 429 rate limit', () => {
    expect(
      kindOf('groq', 498, err('capacity_exceeded', 'Flex tier capacity exceeded', 'capacity_exceeded')).kind,
    ).toBe('overloaded');
    expect(kindOf('groq', 401, err('invalid_api_key', 'Invalid API Key', 'invalid_request_error')).kind).toBe(
      'bad_key',
    );
    expect(
      kindOf('groq', 429, err('rate_limit_exceeded', 'Rate limit reached for model', 'tokens')).kind,
    ).toBe('rate_limited');
  });
  it('Together: 402 spend limit is no credit; the odd 403 for context length is the request', () => {
    expect(
      kindOf('together', 402, err('', 'You have reached your monthly spending limit', 'credit_limit')).kind,
    ).toBe('no_credit');
    expect(
      kindOf(
        'together',
        403,
        err('', 'The input token count exceeds the maximum context length', 'invalid_request_error'),
      ).kind,
    ).toBe('invalid_request');
    expect(kindOf('together', 401, err('', 'Invalid API key provided.', 'invalid_request_error')).kind).toBe(
      'bad_key',
    );
  });
  it('UNCONFIRMED: Fireworks 412 is no credit', () => {
    expect(
      kindOf('fireworks', 412, { error: { message: 'Account is suspended, spending limit exceeded' } }).kind,
    ).toBe('no_credit');
  });
  it('Cerebras: 402 is no credit', () => {
    expect(
      kindOf('cerebras', 402, {
        message: 'Payment required',
        type: 'payment_required_error',
        code: 'payment_required',
      }).kind,
    ).toBe('no_credit');
  });
});

describe('Cloudflare, Perplexity, Cohere and local servers', () => {
  it('UNCONFIRMED: Cloudflare 403 code 10000 is a bad token (an auth status), 429 a rate limit', () => {
    expect(
      kindOf('cloudflare', 403, {
        success: false,
        errors: [{ code: 10000, message: 'Authentication error' }],
        result: null,
      }),
    ).toMatchObject({ kind: 'bad_key', confirmed: false });
    expect(
      kindOf('cloudflare', 429, { success: false, errors: [{ code: 3036, message: 'Rate limited' }] }).kind,
    ).toBe('rate_limited');
  });
  it('Perplexity and Cohere read a 401 and a 429', () => {
    expect(
      kindOf('perplexity', 401, {
        error: { message: 'Unauthorized', type: 'authentication_error', code: 401 },
      }).kind,
    ).toBe('bad_key');
    expect(kindOf('cohere', 401, { message: 'invalid api token' }).kind).toBe('bad_key');
    expect(
      kindOf('cohere', 429, {
        message: 'You are using a Trial key, which is limited to 20 API calls / minute.',
      }).kind,
    ).toBe('rate_limited');
  });
  it('a local server has no key to reject', () => {
    expect(
      kindOf('ollama', 404, { error: { message: "model 'qwen3:14b' not found, try pulling it first" } }).kind,
    ).toBe('invalid_request');
    expect(kindOf('vllm', 500, 'Internal Server Error').kind).toBe('server');
  });
});

describe('the generic profile is conservative', () => {
  it('rejects a key only on a 401 or 403 whose body sounds like authentication, or a bare 401', () => {
    expect(kindOf('some-host', 401, err('', 'Incorrect API key provided')).kind).toBe('bad_key');
    expect(kindOf('some-host', 403, err('', 'Invalid authentication credentials')).kind).toBe('bad_key');
    expect(kindOf('some-host', 401, '').kind).toBe('bad_key');
    // A 403 that is not about authentication is never a bad key (GW1).
    expect(kindOf('some-host', 403, 'Forbidden').kind).toBe('unknown');
    expect(kindOf('some-host', 403, err('', 'Quota exceeded for this project today')).kind).toBe('unknown');
    expect(kindOf('some-host', 403, err('', 'Request throttled, slow down')).kind).toBe('unknown');
    expect(kindOf('some-host', 401, '<html>Bad gateway</html>').kind).toBe('unknown');
  });
  it('402 is no credit, an insufficient_quota 429 is no credit, any other 429 a rate limit', () => {
    expect(kindOf('some-host', 402, '').kind).toBe('no_credit');
    expect(kindOf('some-host', 429, err('insufficient_quota', 'You exceeded your current quota')).kind).toBe(
      'no_credit',
    );
    expect(kindOf('some-host', 429, 'slow down', { 'retry-after': '3' })).toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 3000,
    });
  });
  it('caps an enormous Retry-After', () => {
    expect(kindOf('some-host', 429, '', { 'retry-after': '99999' }).retryAfterMs).toBe(60_000);
  });
  it('reads the cache from every name it knows and says nothing when none is there', () => {
    expect(cacheFromRaw({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 40 } })).toEqual({
      hit: 40,
    });
    expect(cacheFromRaw({ prompt_tokens: 100, cached_tokens: 12 })).toEqual({ hit: 12 });
    expect(cacheFromRaw({ prompt_tokens: 100, completion_tokens: 5 })).toEqual({});
    expect(cacheFromRaw(undefined)).toEqual({});
  });
});

describe('reading an error that was thrown', () => {
  it('takes the status, headers and body from an AI SDK error', () => {
    const sdk = Object.assign(new Error('You exceeded your current quota'), {
      statusCode: 429,
      responseHeaders: { 'retry-after': '2' },
      responseBody: JSON.stringify(
        err('insufficient_quota', 'You exceeded your current quota', 'insufficient_quota'),
      ),
    });
    expect(classifyFailure(profileFor('openai'), sdk, NOW)).toMatchObject({ kind: 'no_credit', status: 429 });
  });
  it('falls back to the message when there is no body', () => {
    const e = Object.assign(new Error('401 invalid x-api-key'), { status: 401 });
    expect(classifyFailure(profileFor('anthropic'), e, NOW).kind).toBe('bad_key');
  });
  it('reads a body that is a string, an object or missing', () => {
    expect(readBody('{"error":{"code":"X","type":"y"}}').codes).toEqual(new Set(['x', 'y']));
    expect(readBody({ error: { code: 1113 } }).codes.has('1113')).toBe(true);
    expect(readBody(undefined).empty).toBe(true);
  });
});

describe('cache fields, per provider', () => {
  const hitOf = (provider: string, usage: unknown) => cacheFromRaw(usage, profileFor(provider).usage);

  it('OpenAI: prompt_tokens_details.cached_tokens, with cache_write_tokens on newer models', () => {
    expect(
      hitOf('openai', {
        prompt_tokens: 2006,
        completion_tokens: 300,
        prompt_tokens_details: { cached_tokens: 1920 },
      }),
    ).toEqual({ hit: 1920 });
    expect(
      hitOf('openai', {
        prompt_tokens: 2006,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1024 },
      }),
    ).toEqual({ hit: 0, write: 1024 });
  });
  it('Anthropic: cache_read_input_tokens and cache_creation_input_tokens, and input leaves them out', () => {
    expect(
      hitOf('anthropic', {
        input_tokens: 50,
        output_tokens: 10,
        cache_read_input_tokens: 4096,
        cache_creation_input_tokens: 512,
      }),
    ).toEqual({ hit: 4096, write: 512 });
    expect(profileFor('anthropic').usage.inputIncludesCache).toBe(false);
    expect(profileFor('openai').usage.inputIncludesCache).toBe(true);
  });
  it('DeepSeek: prompt_cache_hit_tokens', () => {
    expect(
      hitOf('deepseek', { prompt_tokens: 1000, prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 360 }),
    ).toEqual({ hit: 640 });
  });
  it('Moonshot: details first, the older top-level cached_tokens too, and writes', () => {
    expect(
      hitOf('moonshot', {
        prompt_tokens: 3000,
        prompt_tokens_details: { cached_tokens: 2048, cache_write_tokens: 512 },
      }),
    ).toEqual({ hit: 2048, write: 512 });
    expect(hitOf('moonshot', { prompt_tokens: 3000, cached_tokens: 1024 })).toEqual({ hit: 1024 });
  });
  it('MiniMax, Qwen, Z.ai, xAI, Mistral, Groq, Cerebras: prompt_tokens_details.cached_tokens', () => {
    for (const p of ['minimax', 'qwen', 'zai', 'xai', 'mistral', 'groq', 'cerebras', 'perplexity'])
      expect(hitOf(p, { prompt_tokens: 900, prompt_tokens_details: { cached_tokens: 300 } })).toEqual({
        hit: 300,
      });
  });
  it('Qwen reports writes as cache_creation_input_tokens', () => {
    expect(
      hitOf('qwen', {
        prompt_tokens: 900,
        prompt_tokens_details: { cached_tokens: 0, cache_creation_input_tokens: 700 },
      }),
    ).toEqual({ hit: 0, write: 700 });
  });
  it('Together: top-level cached_tokens on some models, the details on others', () => {
    expect(hitOf('together', { prompt_tokens: 800, cached_tokens: 256 })).toEqual({ hit: 256 });
    expect(hitOf('together', { prompt_tokens: 800, prompt_tokens_details: { cached_tokens: 128 } })).toEqual({
      hit: 128,
    });
  });
  it('OpenRouter: details, writes and a negative cache_discount left alone', () => {
    expect(
      hitOf('openrouter', {
        prompt_tokens: 500,
        prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 50 },
        cost: 0.002,
        cache_discount: -0.0001,
      }),
    ).toEqual({ hit: 100, write: 50 });
  });
  it('Cohere: cached_tokens', () => {
    expect(hitOf('cohere', { cached_tokens: 64, tokens: { input_tokens: 100 } })).toEqual({ hit: 64 });
  });
  it('a local server that reports none gives nothing, not zero', () => {
    expect(hitOf('ollama', { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 })).toEqual({});
  });
  it('says what each provider caches and what a hit is worth', () => {
    expect(profileFor('cerebras').cache.readDiscount).toBe(false);
    expect(profileFor('anthropic').cache).toMatchObject({ mode: 'both', writeCostsExtra: true });
    expect(profileFor('openai').cache.mode).toBe('automatic');
    expect(profileFor('deepseek').reasoning).toMatchObject({
      replay: 'with_tools',
      field: 'reasoning_content',
    });
    expect(profileFor('generic').cache.confirmed).toBe(false);
  });
});
