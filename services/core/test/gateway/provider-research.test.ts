/**
 * ------------------------------------------------------------------
 *  Title    |  Provider facts, checked against the providers' own docs
 *  Ref      |  roadmap PV3, GW1, CR1 · gateway/profiles.ts, provider-errors.ts
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  A second research pass (20 Oct 2026) found places where a
 *           |  provider's failure needs words of its own, because the fix
 *           |  is not "top up": a spend cap that must never be retried, a
 *           |  Coding Plan used from a tool it does not cover, a plan
 *           |  window that only time cures, a negative balance that blocks
 *           |  free models. Each shape here is the one the docs show.
 *  Note     |  Bodies are hand-written from the docs; no provider is
 *           |  called. The Claude bridge test spawns a stub, not Claude.
 * ------------------------------------------------------------------
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelsFile } from '@nvx/contracts';
import type { ClassifiedError } from '@nvx/resilience';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { BRIDGE_ENV, processLauncher } from '../../src/claudecode/bridge';
import { profileFor, recogniseKey } from '../../src/gateway/profiles';
import { classifyProviderError, failureWords } from '../../src/gateway/provider-errors';
import { wrap } from '../../src/gateway/providers';
import { inWindows } from '../../src/gateway/usage';
import { testFailed } from '../../src/setup/routes';

const sdkError = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Object.assign(new Error(JSON.stringify(body)), {
    statusCode: status,
    responseHeaders: headers,
    responseBody: JSON.stringify(body),
  });

const words = (provider: string, status: number, body: unknown, headers?: Record<string, string>) =>
  wrap(sdkError(status, body, headers), provider) as ClassifiedError;

describe('Anthropic: four shapes that all look like "out of money", four different fixes', () => {
  // platform.claude.com/docs/en/api/rate-limits and /errors
  const spendCap = {
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: 'You have reached your workspace spend limit.',
      details: { error_code: 'enforced_spend_limit_reached' },
    },
  };
  const ownLimit = {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message:
        'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.',
    },
  };
  const empty = {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.',
    },
  };
  const billing = {
    type: 'error',
    error: { type: 'billing_error', message: 'There is an issue with billing.' },
  };

  it('the tier spend cap is a 429 with no retry-after: permanent, never retried, told by its code', () => {
    const e = words('anthropic', 429, spendCap);
    expect(e).toMatchObject({ errorClass: 'permanent', code: 'provider.no_credit', status: 429 });
    expect(e.retryAfterMs).toBeUndefined();
    expect(e.title).toBe('Anthropic has stopped requests at your monthly spend cap');
    expect(e.hint).toContain('Retrying will not help');
    expect(e.hint).toContain('00:00 UTC on the 1st');
  });

  it('is still the spend cap when the wording changes, because the code is what is read', () => {
    const odd = { type: 'error', error: { ...spendCap.error, message: 'Limit.' } };
    expect(words('anthropic', 429, odd)).toMatchObject({
      errorClass: 'permanent',
      code: 'provider.no_credit',
    });
  });

  it('a spend cap on a key that draws on the plan credit is not "the credit is used up"', () => {
    const profile = profileFor('anthropic');
    const seen = classifyProviderError(profile, 429, spendCap, undefined, Date.now(), '', {
      planCredit: true,
    });
    expect(seen).toMatchObject({ kind: 'no_credit', note: 'spend_cap', confirmed: true });
  });

  it('a limit you set yourself is a 400 with its own words', () => {
    const e = words('anthropic', 400, ownLimit);
    expect(e).toMatchObject({ errorClass: 'permanent', code: 'provider.no_credit' });
    expect(e.title).toBe('You have reached the usage limit you set at Anthropic');
    expect(e.hint).toContain('Raise the limit');
  });

  it('billing is a 402 and says to check the payment, not to top up', () => {
    const e = words('anthropic', 402, billing);
    expect(e).toMatchObject({ errorClass: 'permanent', code: 'provider.no_credit' });
    expect(e.title).toBe('Anthropic reports a billing problem');
    expect(e.hint).toContain('a payment may have failed');
  });

  it('an empty balance is the plain "top up"', () => {
    const e = words('anthropic', 400, empty);
    expect(e).toMatchObject({ errorClass: 'permanent', code: 'provider.no_credit' });
    expect(e.hint).toBe('Top up at Anthropic, or pick another model.');
  });

  it('a real rate limit with retry-after still waits', () => {
    const limited = {
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Number of tokens exceeded.' },
    };
    expect(words('anthropic', 429, limited, { 'retry-after': '9' })).toMatchObject({
      errorClass: 'transient',
      retryAfterMs: 9000,
    });
  });

  it('the setup key test says the same words', () => {
    const e = testFailed('anthropic', sdkError(429, spendCap));
    expect(e).toMatchObject({ code: 'provider.no_credit', errorClass: 'permanent' });
    expect(e.title).toBe('Anthropic has stopped requests at your monthly spend cap');
  });
});

describe('Kimi (Moonshot): out of balance and a rate limit are both 429', () => {
  const quota = (message: string) => ({ error: { type: 'exceeded_current_quota_error', message } });
  const rate = (message: string) => ({ error: { type: 'rate_limit_reached_error', message } });

  it('error.type decides, whatever the message says', () => {
    expect(words('moonshot', 429, quota('Account balance is insufficient'))).toMatchObject({
      code: 'provider.no_credit',
      errorClass: 'permanent',
    });
    expect(words('moonshot', 429, quota('Token quota is insufficient'))).toMatchObject({
      code: 'provider.no_credit',
    });
    const limited = words('moonshot', 429, rate('Your account is limited to 3 requests per minute'), {
      'retry-after': '2',
    });
    expect(limited).toMatchObject({ errorClass: 'transient', retryAfterMs: 2000 });
    expect(limited.code).toBeUndefined();
    // A rate limit whose message mentions the word "quota" is still a rate limit.
    expect(words('moonshot', 429, rate('TPM quota reached'))).toMatchObject({ errorClass: 'transient' });
  });

  it('a 429 with the balance words but no type is still money', () => {
    expect(words('moonshot', 429, { error: { message: 'Account balance is insufficient' } })).toMatchObject({
      code: 'provider.no_credit',
    });
  });
});

describe('Z.ai: 1113 is not always "top up"', () => {
  it('says the plan may have been used from a tool it does not cover', () => {
    const e = words('zai', 429, {
      error: { code: '1113', message: 'Insufficient balance or no resource package. Please recharge.' },
    });
    expect(e).toMatchObject({ code: 'provider.no_credit', errorClass: 'permanent' });
    expect(e.hint).toContain('Top up');
    expect(e.hint).toContain('Coding Plan');
    expect(e.hint).toContain('tool it does not cover');
  });

  it('the Coding Plan caps are a wait, and say it never draws on the balance', () => {
    for (const code of ['1310', '1316', '1317']) {
      const e = words('zai', 429, { error: { code, message: 'Usage limit reached' } });
      expect(e.code, code).toBe('provider.no_credit');
      expect(e.hint, code).toContain('never draws on your account balance');
      expect(e.hint, code).not.toContain('Top up');
    }
  });

  it('the other credit codes keep the plain words', () => {
    expect(
      words('zai', 429, { error: { code: '1308', message: 'Usage limit reached for 5 hour' } }).hint,
    ).toBe('Top up at Z.ai (GLM), or pick another model.');
  });
});

describe('OpenRouter: a negative balance gives 402, even on free models', () => {
  it('402 says that, and is permanent', () => {
    const e = words('openrouter', 402, { error: { code: 402, message: 'Insufficient credits.' } });
    expect(e).toMatchObject({ code: 'provider.no_credit', errorClass: 'permanent' });
    expect(e.hint).toContain('below zero');
    expect(e.hint).toContain('free ones too');
  });

  it('a 402 for the in-flight budget is transient, not an empty balance', () => {
    const e = words('openrouter', 402, {
      error: { code: 402, message: 'Budget busy', metadata: { reason: 'in_flight_budget_exhausted' } },
    });
    expect(e.errorClass).toBe('transient');
    expect(e.code).toBeUndefined();
  });
});

describe('MiniMax: subscription and pay-as-you-go keys are separate wallets', () => {
  it('reads the two key prefixes by kind', () => {
    expect(recogniseKey('sk-cp-abcdef0123')).toMatchObject({
      provider: 'minimax',
      kind: 'subscription',
      confirmed: true,
    });
    expect(recogniseKey('sk-api-abcdef0123')).toMatchObject({
      provider: 'minimax',
      kind: 'pay_as_you_go',
      confirmed: true,
    });
  });

  it('2056 (the plan window) is a wait; 1008 (balance) is a top-up', () => {
    const window = words('minimax', 200, {
      base_resp: { status_code: 2056, status_msg: 'Usage Limit Exceeded' },
    });
    expect(window).toMatchObject({ code: 'provider.no_credit', errorClass: 'permanent' });
    expect(window.hint).toContain('Wait for the next window');
    expect(window.hint).toContain('never spends your pay-as-you-go balance');
    const balance = words('minimax', 200, {
      base_resp: { status_code: 1008, status_msg: 'insufficient balance' },
    });
    expect(balance.hint).toBe('Top up at MiniMax, or pick another model.');
  });

  it('a rejected key is told the two kinds are separate', () => {
    const w = failureWords('bad_key', profileFor('minimax'), {});
    expect(w?.hint).toContain('sk-cp-');
    expect(w?.hint).toContain('sk-api-');
  });
});

describe('Alibaba (Model Studio): plan keys are their own product', () => {
  it('reads sk-sp- as a plan key, and still needs the provider named for a bare sk-', () => {
    expect(recogniseKey('sk-sp-abcdef0123')).toMatchObject({
      provider: 'qwen',
      kind: 'plan',
      confirmed: true,
    });
    expect(recogniseKey('sk-abcdef0123')).toBeNull();
    expect(recogniseKey('sk-abcdef0123', 'qwen')).toMatchObject({ provider: 'qwen', kind: 'standard' });
  });

  it('a rejected key is told a plan key never works at the general address', () => {
    const w = failureWords('bad_key', profileFor('qwen'), { region: 'singapore', regionHint: true });
    expect(w?.hint).toContain('sk-sp-');
    expect(w?.hint).toContain('own plan address');
  });

  it('keeps the region facts: Token Plan is Beijing only, the free quota is Singapore only', () => {
    const q = profileFor('qwen');
    expect(q.regions?.map((r) => r.id)).toEqual(['singapore', 'beijing', 'us']);
    const notes = (q.notes ?? []).join(' ');
    expect(notes).toMatch(/Token Plan is sold in the China \(Beijing\) region only/);
    expect(notes).toMatch(/free quota applies only to the Singapore region/);
    expect(notes).toMatch(/never falls back to pay-as-you-go/);
  });
});

describe('Kimi regions and DeepSeek peak hours', () => {
  it('Kimi .ai and .cn are separate platforms', () => {
    const regions = profileFor('moonshot').regions ?? [];
    expect(regions.map((r) => r.baseUrl)).toEqual([
      'https://api.moonshot.ai/v1',
      'https://api.moonshot.cn/v1',
    ]);
    expect((profileFor('moonshot').notes ?? []).join(' ')).toMatch(/separate platforms with separate keys/);
  });

  it('DeepSeek: peak is full price 01-04 and 06-10 UTC on weekdays, half price at every other time', () => {
    const file = fileURLToPath(new URL('../../../../config/models.yaml', import.meta.url));
    const models = ModelsFile.parse(parse(readFileSync(file, 'utf8'))).models;
    for (const id of ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-flash']) {
      const m = models.find((x) => x.id === id);
      const w = m?.price.off_peak?.windows ?? [];
      const off = (iso: string) => inWindows(w, Date.parse(`${iso}Z`));
      // 2026-10-23 is a Friday, 2026-10-24 a Saturday.
      expect(off('2026-10-23T01:00:00'), id).toBe(false);
      expect(off('2026-10-23T03:59:59'), id).toBe(false);
      expect(off('2026-10-23T04:00:00'), id).toBe(true);
      expect(off('2026-10-23T06:00:00'), id).toBe(false);
      expect(off('2026-10-23T09:59:59'), id).toBe(false);
      expect(off('2026-10-23T10:00:00'), id).toBe(true);
      expect(off('2026-10-24T02:00:00'), id).toBe(true);
      expect(off('2026-10-24T08:00:00'), id).toBe(true);
      expect(m?.price.off_peak?.input_per_mtok, id).toBeCloseTo((m?.price.input_per_mtok ?? 0) / 2, 6);
    }
  });

  it('says in the profile that Chinese public holidays cannot be known', () => {
    const notes = (profileFor('deepseek').notes ?? []).join(' ');
    expect(notes).toMatch(/excluding Chinese public holidays/);
    expect(notes).toMatch(/cannot be known here/);
  });
});

describe('OpenRouter facts the profile carries', () => {
  it('free model limits and the BYOK fee', () => {
    const notes = (profileFor('openrouter').notes ?? []).join(' ');
    expect(notes).toMatch(/50 requests a day/);
    expect(notes).toMatch(/1,000 a day once you have ever bought \$10/);
    expect(notes).toMatch(/BYOK key costs 5%/);
    expect(notes).toMatch(/falls back to its shared capacity/);
  });
});

describe('a stray ANTHROPIC_API_KEY never reaches a Claude Code plan session', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('keeps the credentials that would override the login off the allow-list', () => {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ])
      expect(BRIDGE_ENV, name).not.toContain(name);
  });

  it('spawns the bridge without them even when Core itself has them set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ancile-env-'));
    dirs.push(dir);
    const entry = join(dir, 'stub-bridge.js');
    writeFileSync(
      entry,
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.ANCILE_BRIDGE_DATA_DIR + '/env-names.json', JSON.stringify(Object.keys(process.env)));",
        "console.log('ANCILE_BRIDGE_READY' + JSON.stringify({ port: 1 }));",
        "process.stdin.on('end', () => process.exit(0));",
        'process.stdin.resume();',
      ].join('\n'),
    );
    const stray = {
      ANTHROPIC_API_KEY: 'sk-ant-api03-STRAYSTRAYSTRAY',
      ANTHROPIC_AUTH_TOKEN: 'stray-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'stray-oauth',
    };
    const before = Object.fromEntries(Object.keys(stray).map((k) => [k, process.env[k]]));
    Object.assign(process.env, stray);
    let bridge: Awaited<ReturnType<ReturnType<typeof processLauncher>>> | undefined;
    try {
      bridge = await processLauncher({ dataDir: dir, entry, readyTimeoutMs: 10_000 })();
      const names = JSON.parse(readFileSync(join(dir, 'env-names.json'), 'utf8')) as string[];
      for (const k of Object.keys(stray)) expect(names).not.toContain(k);
      expect(names).toContain('ANCILE_BRIDGE_TOKEN');
    } finally {
      bridge?.stop();
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
