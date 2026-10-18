/**
 * ------------------------------------------------------------------
 *  Title    |  Provider failures in the gateway (GW1)
 *  Ref      |  gateway/providers.ts (wrap), gateway.ts, setup/routes.ts
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  A 429 is not always the same trouble. No credit is
 *           |  permanent for that provider and the chain moves on at
 *           |  once; a rate limit with a short Retry-After is waited
 *           |  for and the same model asked again before any fallback;
 *           |  a wrong region or a model the key may not use has its
 *           |  own words. A key is only ever called rejected on a 401
 *           |  or 403 that sounds like authentication.
 * ------------------------------------------------------------------
 */

import type { ModelConfig } from '@nvx/contracts';
import { CircuitBreaker, ClassifiedError, instantClock } from '@nvx/resilience';
import { describe, expect, it } from 'vitest';
import { Gateway, SHORT_RETRY_AFTER_MS } from '../../src/gateway/gateway';
import { wrap } from '../../src/gateway/providers';
import type { GatewayEvent, ModelClient, ModelRequest, StreamChunk } from '../../src/gateway/types';
import { testFailed } from '../../src/setup/routes';
import { fakeModel } from './fake-provider';

/** What the AI SDK throws for a failed HTTP call. */
const sdkError = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Object.assign(new Error(typeof body === 'string' ? body : JSON.stringify(body)), {
    statusCode: status,
    responseHeaders: headers,
    responseBody: typeof body === 'string' ? body : JSON.stringify(body),
  });

const NO_CREDIT = {
  error: { code: 'credit_balance_exhausted', message: 'You exceeded your current quota.' },
};
const RATE = { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' } };

describe('wrap: an SDK error read through the provider', () => {
  it('OpenAI out of credit is permanent with its own code and words, and is not retried', () => {
    const e = wrap(sdkError(429, NO_CREDIT), 'openai') as ClassifiedError;
    expect(e).toBeInstanceOf(ClassifiedError);
    expect(e.errorClass).toBe('permanent');
    expect(e.code).toBe('provider.no_credit');
    expect(e.title).toBe('OpenAI says your account is out of credit');
    expect(e.hint).toBe('Top up at OpenAI, or pick another model.');
    expect(e.status).toBe(429);
  });

  it('a plain 429 is transient and carries Retry-After in seconds', () => {
    const e = wrap(sdkError(429, RATE, { 'retry-after': '4' }), 'openai') as ClassifiedError;
    expect(e).toMatchObject({ errorClass: 'transient', retryAfterMs: 4000 });
    expect(e.code).toBeUndefined();
  });

  it('honours a Retry-After given as an HTTP date', () => {
    const date = new Date(Date.now() + 6000).toUTCString();
    const e = wrap(sdkError(429, RATE, { 'Retry-After': date }), 'moonshot') as ClassifiedError;
    expect(e.errorClass).toBe('transient');
    expect(e.retryAfterMs).toBeGreaterThan(3000);
    expect(e.retryAfterMs).toBeLessThanOrEqual(6000);
  });

  it('Kimi: quota is no credit, overload is transient', () => {
    const quota = { error: { type: 'exceeded_current_quota_error', message: 'insufficient balance' } };
    const busy = { error: { type: 'engine_overloaded_error', message: 'busy' } };
    expect((wrap(sdkError(429, quota), 'moonshot') as ClassifiedError).code).toBe('provider.no_credit');
    expect(wrap(sdkError(429, busy), 'moonshot')).toMatchObject({ errorClass: 'transient' });
  });

  it('Z.ai: a 429 with 1113 is no credit, 1311 is a model not permitted, 1302 a rate limit', () => {
    const z = (code: string) => ({ error: { code, message: 'x' } });
    expect((wrap(sdkError(429, z('1113')), 'zai') as ClassifiedError).code).toBe('provider.no_credit');
    const m = wrap(sdkError(429, z('1311')), 'zai', { model: 'GLM-5.3' }) as ClassifiedError;
    expect(m).toMatchObject({ code: 'provider.model_not_permitted', errorClass: 'permanent' });
    expect(m.title).toBe("Z.ai (GLM) says this key can't use GLM-5.3");
    expect(wrap(sdkError(429, z('1302')), 'zai')).toMatchObject({ errorClass: 'transient' });
  });

  it('DeepSeek 402 is no credit, where the generic rules would have called it a policy block', () => {
    const e = wrap(
      sdkError(402, { error: { message: 'Insufficient Balance' } }),
      'deepseek',
    ) as ClassifiedError;
    expect(e).toMatchObject({ errorClass: 'permanent', code: 'provider.no_credit' });
  });

  it('Qwen: a key from the other region is wrong_region and names where to look', () => {
    const body = {
      error: {
        code: 'invalid_api_key',
        message: 'Incorrect API key. This key is for the China (mainland) site.',
      },
    };
    const e = wrap(sdkError(401, body), 'qwen', { region: 'singapore' }) as ClassifiedError;
    expect(e.code).toBe('provider.wrong_region');
    expect(e.hint).toContain('China (Beijing)');
    expect(e.hint).not.toContain('Singapore');
    expect(e.errorClass).toBe('permanent');
  });

  it('a 401 on a region-bound provider is a bad key with a hint about the region', () => {
    const e = wrap(sdkError(401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' }), 'qwen', {
      region: 'singapore',
    }) as ClassifiedError;
    expect(e.code).toBe('provider.auth_failed');
    expect(e.hint).toContain('region');
  });

  it('a 403 that is not about authentication is never a bad key', () => {
    const e = wrap(sdkError(403, 'Forbidden: request blocked by usage policy'), 'groq') as ClassifiedError;
    expect(e.code).toBeUndefined();
    // And the generic status rules still decide its class.
    expect(e.errorClass).toBe('permanent');
  });

  it('leaves what it cannot place to the status rules: a 500 is transient, an overflow is context_overflow', () => {
    expect(wrap(sdkError(500, 'oops'), 'deepseek')).toMatchObject({ errorClass: 'transient' });
    expect(
      wrap(sdkError(400, { error: { message: 'maximum context length is 8192 tokens' } }), 'openai'),
    ).toMatchObject({ errorClass: 'context_overflow' });
  });

  it('keeps an error that already has a class', () => {
    const own = new ClassifiedError('capacity', 'node waking');
    expect(wrap(own, 'openai')).toBe(own);
  });
});

/** A client whose attempts are scripted per model id: an error to throw, or text to say. */
function scripted(plan: Record<string, (Error | string)[]>): ModelClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async *stream(m: ModelConfig, _req: ModelRequest): AsyncIterable<StreamChunk> {
      calls.push(m.id);
      const step = plan[m.id]?.shift();
      if (step instanceof Error) throw step;
      yield {
        type: 'text',
        delta: step ?? 'ok, here is an answer that is long enough to be released at once.',
      };
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

const run = async (client: ModelClient, chain: ModelConfig[], slept: number[]) => {
  const gw = new Gateway({
    client,
    breaker: new CircuitBreaker({ clock: instantClock() }),
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  const events: GatewayEvent[] = [];
  let error: unknown;
  try {
    for await (const e of gw.stream(
      chain,
      { messages: [{ role: 'user', content: 'hello' }] },
      new AbortController().signal,
    ))
      events.push(e);
  } catch (err) {
    error = err;
  }
  return { events, error, fallbacks: events.filter((e) => e.type === 'fallback') };
};

describe('the gateway on rate limits and credit', () => {
  const a = fakeModel('a', 'echo');
  const b = fakeModel('b', 'echo');
  const limited = (seconds: number) =>
    wrap(sdkError(429, RATE, { 'retry-after': String(seconds) }), 'openai');

  it('waits out a short Retry-After and asks the same model again before any fallback', async () => {
    const client = scripted({ [a.id]: [limited(2) as Error] });
    const slept: number[] = [];
    const r = await run(client, [a, b], slept);
    expect(client.calls).toEqual([a.id, a.id]);
    expect(r.fallbacks).toHaveLength(0);
    expect(r.error).toBeUndefined();
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThanOrEqual(2000);
  });

  it('falls back when the second ask is limited again, and when the wait is long', async () => {
    const twice = scripted({ [a.id]: [limited(1) as Error, limited(1) as Error] });
    const r1 = await run(twice, [a, b], []);
    expect(twice.calls).toEqual([a.id, a.id, b.id]);
    expect(r1.fallbacks).toHaveLength(1);

    const long = scripted({ [a.id]: [limited(SHORT_RETRY_AFTER_MS / 1000 + 5) as Error] });
    const slept: number[] = [];
    const r2 = await run(long, [a, b], slept);
    expect(long.calls).toEqual([a.id, b.id]);
    expect(slept).toEqual([]);
    expect(r2.fallbacks).toHaveLength(1);
  });

  it('does not wait on a rate limit that gave no Retry-After', async () => {
    const client = scripted({ [a.id]: [wrap(sdkError(429, RATE), 'openai') as Error] });
    const slept: number[] = [];
    await run(client, [a, b], slept);
    expect(client.calls).toEqual([a.id, b.id]);
    expect(slept).toEqual([]);
  });

  it('moves on from a provider that is out of credit at once, never retrying it, and says why', async () => {
    const client = scripted({
      [a.id]: [wrap(sdkError(429, NO_CREDIT, { 'retry-after': '1' }), 'openai') as Error],
    });
    const slept: number[] = [];
    const r = await run(client, [a, b], slept);
    expect(client.calls).toEqual([a.id, b.id]);
    expect(slept).toEqual([]);
    expect(r.fallbacks).toHaveLength(1);
  });

  it('when every model fails the last attempt carries the code and words for the error shown', async () => {
    const client = scripted({
      [a.id]: [wrap(sdkError(429, RATE), 'openai') as Error],
      [b.id]: [wrap(sdkError(402, { error: { message: 'Insufficient Balance' } }), 'deepseek') as Error],
    });
    const r = await run(client, [a, b], []);
    const failed = r.error as { attempts: { code?: string; title?: string; hint?: string }[] };
    expect(failed.attempts.at(-1)).toMatchObject({
      code: 'provider.no_credit',
      title: 'DeepSeek says your account is out of credit',
      hint: 'Top up at DeepSeek, or pick another model.',
    });
    expect(failed.attempts[0]?.code).toBeUndefined();
  });
});

describe('Test key reports the same classes', () => {
  const failing = (status: number, body: unknown) =>
    testFailed('openai', sdkError(status, body), 'sk-secret-key');

  it('a 429 rate limit is never "rejected"', () => {
    const e = failing(429, RATE);
    expect(e.code).toBe('provider.unavailable');
    expect(e.title).toContain('limiting requests');
  });

  it('no credit has its own code and a hint to top up', () => {
    const e = failing(429, NO_CREDIT);
    expect(e).toMatchObject({
      code: 'provider.no_credit',
      title: 'OpenAI says your account is out of credit',
      hint: 'Top up at OpenAI, or pick another model.',
    });
  });

  it('a real rejection still says so, and the key is scrubbed from the detail', () => {
    const e = testFailed(
      'openai',
      sdkError(401, {
        error: { code: 'invalid_api_key', message: 'Incorrect API key provided: sk-secret-key' },
      }),
      'sk-secret-key',
    );
    expect(e.code).toBe('provider.auth_failed');
    expect(e.title).toBe('OpenAI rejected the API key');
    expect(e.detail).not.toContain('sk-secret-key');
  });

  it('a 403 that is quota is not a rejected key', () => {
    const e = testFailed('groq', sdkError(403, { error: { message: 'Quota exceeded for this project' } }));
    expect(e.code).toBe('provider.unavailable');
  });

  it('names the other region for a key from the wrong one', () => {
    const e = testFailed(
      'moonshot',
      sdkError(401, { error: { type: 'invalid_authentication_error', message: 'Invalid Authentication' } }),
      undefined,
      'global',
    );
    expect(e.code).toBe('provider.auth_failed');
    expect(e.hint).toContain('China');
  });

  it('a model the key may not use has its own code', () => {
    const e = testFailed(
      'anthropic',
      sdkError(403, { type: 'error', error: { type: 'permission_error', message: 'no access' } }),
    );
    expect(e.code).toBe('provider.model_not_permitted');
  });

  it('names the provider it knows by its profile', () => {
    const e = testFailed('deepseek', sdkError(402, { error: { message: 'Insufficient Balance' } }));
    expect(e.title).toBe('DeepSeek says your account is out of credit');
  });
});
