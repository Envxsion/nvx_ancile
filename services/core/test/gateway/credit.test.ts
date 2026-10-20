/**
 * The plan's monthly API credit (CR1): the cycle, the ledger, who pays,
 * the out-of-credit error, the models that spend it and the routing goal.
 * Offline only: no call reaches Anthropic.
 */
import { isCreditModel, type ModelConfig, PLAN_CREDIT_PAYER } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { BRIDGE_ENV } from '../../src/claudecode/bridge';
import { claudeCodeModels, syncClaudeCodeModels } from '../../src/engines/mode-a';
import { billingOf, paidFromCredit } from '../../src/gateway/billing';
import { CREDIT_SETTING, CreditLedger, cycleOf, WARN_AT } from '../../src/gateway/credit';
import { preferCreditFirst } from '../../src/gateway/credit-routing';
import { profileFor } from '../../src/gateway/profiles';
import { classifyProviderError, errorClassFor, failureWords } from '../../src/gateway/provider-errors';
import { ModelRegistry } from '../../src/gateway/registry';
import { redact, redactText } from '../../src/obs/redact';
import { MemorySecretStore, SecretBox } from '../../src/secrets';
import { MemorySettings } from '../../src/settings';

const D = (iso: string) => Date.parse(iso);

describe('the credit cycle', () => {
  it('runs from the reset day at local midnight to the next one', () => {
    const c = cycleOf(D('2026-10-20T12:00:00Z'), 15, 'Europe/London');
    // 15 Oct is still British Summer Time (UTC+1): local midnight is 23:00 UTC the day before.
    expect(new Date(c.start).toISOString()).toBe('2026-10-14T23:00:00.000Z');
    // 15 Nov is GMT.
    expect(new Date(c.end).toISOString()).toBe('2026-11-15T00:00:00.000Z');
  });

  it('is still last month before the reset day', () => {
    const c = cycleOf(D('2026-10-10T12:00:00Z'), 15, 'UTC');
    expect(new Date(c.start).toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(new Date(c.end).toISOString()).toBe('2026-10-15T00:00:00.000Z');
  });

  it('uses the last day of a short month for day 31, and crosses the year', () => {
    const feb = cycleOf(D('2026-03-05T00:00:00Z'), 31, 'UTC');
    expect(new Date(feb.start).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(new Date(feb.end).toISOString()).toBe('2026-03-31T00:00:00.000Z');
    const dec = cycleOf(D('2026-12-20T00:00:00Z'), 1, 'UTC');
    expect(new Date(dec.end).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    const jan = cycleOf(D('2027-01-01T00:00:00Z'), 1, 'UTC');
    expect(new Date(jan.start).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('is cut in the time zone given, not UTC', () => {
    // 22:00 UTC on 14 Oct is already 15 Oct in Sydney (UTC+11): a new cycle there, the old one in London.
    const at = D('2026-10-14T22:00:00Z');
    expect(new Date(cycleOf(at, 15, 'Australia/Sydney').start).toISOString()).toBe(
      '2026-10-14T13:00:00.000Z',
    );
    expect(new Date(cycleOf(at, 15, 'Europe/London').start).toISOString()).toBe('2026-09-14T23:00:00.000Z');
  });
});

describe('the ledger', () => {
  const setup = (spent: number, now = D('2026-10-28T09:00:00Z')) => {
    const settings = new MemorySettings();
    const sent: { id: string; title: string }[] = [];
    const seen: { from?: Date; to?: Date } = {};
    let total = spent;
    const states: { enabled: boolean; exhausted: boolean; first: boolean }[] = [];
    const ledger = new CreditLedger({
      settings,
      spend: {
        spentUsd: async (from, to) => {
          seen.from = from;
          seen.to = to;
          return total;
        },
      },
      notify: (n) => {
        sent.push(n);
      },
      onState: (s) => states.push(s),
      now: () => now,
      defaultTz: () => 'UTC',
    });
    return { ledger, settings, sent, seen, states, spend: (n: number) => (total = n) };
  };
  const config = { enabled: true, monthly_usd: 100, resets_on_day: 1, tz: 'UTC' };

  it('counts this cycle against the monthly amount and says it is its own count', async () => {
    const t = setup(37.5);
    await t.ledger.setConfig(config);
    const s = await t.ledger.status();
    expect(s).toMatchObject({
      monthly_usd: 100,
      spent_usd: 37.5,
      left_usd: 62.5,
      used: 0.375,
      exhausted: false,
      counted_by_ancile: true,
      days_left: 4,
    });
    expect(s?.cycle_start).toBe('2026-10-01T00:00:00.000Z');
    expect(s?.cycle_ends).toBe('2026-11-01T00:00:00.000Z');
    expect(t.seen.from?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(t.seen.to?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('says nothing until it is set up, and never goes below nothing left', async () => {
    const t = setup(120);
    expect(await t.ledger.status()).toBeNull();
    await t.ledger.setConfig(config);
    expect(await t.ledger.status()).toMatchObject({ left_usd: 0, used: 1.2, exhausted: false });
  });

  it('warns once a cycle at 80%, not before', async () => {
    const t = setup(79);
    await t.ledger.setConfig(config);
    expect(await t.ledger.check()).toBe(false);
    t.spend(100 * WARN_AT);
    expect(await t.ledger.check()).toBe(true);
    expect(await t.ledger.check()).toBe(false);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.title).toBe('80% of your monthly API credit is used');
  });

  it('marks the credit spent when Anthropic says so, once, and saving again tries it again', async () => {
    const t = setup(10);
    await t.ledger.setConfig(config);
    await t.ledger.markExhausted();
    await t.ledger.markExhausted();
    expect(t.sent).toHaveLength(1);
    expect((await t.ledger.status())?.exhausted).toBe(true);
    expect(t.states.at(-1)).toMatchObject({ enabled: true, exhausted: true, first: false });
    await t.ledger.setConfig(config);
    expect((await t.ledger.status())?.exhausted).toBe(false);
    expect(await t.settings.get(CREDIT_SETTING.exhausted)).toBeUndefined();
  });

  it('forgets an exhaustion from an earlier cycle', async () => {
    const t = setup(10, D('2026-10-28T09:00:00Z'));
    await t.ledger.setConfig(config);
    await t.settings.set(CREDIT_SETTING.exhausted, '2026-09-01T00:00:00.000Z');
    expect((await t.ledger.status())?.exhausted).toBe(false);
  });

  it('spends expiring credit first only when asked, in the last days, with credit left', async () => {
    const t = setup(40);
    await t.ledger.setConfig(config);
    expect(await t.ledger.refreshGoal()).toBe(false); // off by default
    await t.ledger.setRouting({ spend_credit_first: true, last_days: 5 });
    expect(t.ledger.spendFirst()).toBe(true); // 4 days left
    await t.ledger.setRouting({ spend_credit_first: true, last_days: 3 });
    expect(t.ledger.spendFirst()).toBe(false);
    await t.ledger.setRouting({ spend_credit_first: true, last_days: 5 });
    t.spend(100);
    expect(await t.ledger.refreshGoal()).toBe(false); // nothing left
  });
});

describe('who pays', () => {
  const anthropic = { id: 'anthropic/claude-sonnet-5-5', provider: 'anthropic', via: 'direct' as const };
  it('an Anthropic key marked as drawing on the credit reports billing credit', () => {
    expect(billingOf(anthropic, null, true)).toEqual({ kind: 'credit', payer: PLAN_CREDIT_PAYER });
    expect(billingOf(anthropic, null, false)).toEqual({ kind: 'key', payer: 'anthropic' });
  });
  it('only the monthly-credit Claude Code variants spend it; the plan ones stay on the plan', () => {
    const max = { signed_in: true, auth_method: 'claude.ai', plan: 'Max' };
    expect(
      billingOf({ id: 'claude-code/opus@credit', provider: 'claude_code', via: 'direct' }, max, true),
    ).toEqual({
      kind: 'credit',
      payer: PLAN_CREDIT_PAYER,
    });
    expect(billingOf({ id: 'claude-code/opus', provider: 'claude_code', via: 'direct' }, max, true)).toEqual({
      kind: 'plan',
      payer: 'max',
    });
  });
  it('other providers and custom endpoints are untouched', () => {
    expect(paidFromCredit({ provider: 'openai', via: 'direct' }, true)).toBe(false);
    expect(
      paidFromCredit(
        { provider: 'anthropic', via: 'direct', base_url: 'https://proxy.example.com/v1' },
        true,
      ),
    ).toBe(false);
  });
});

describe('the out-of-credit error', () => {
  const anthropic = profileFor('anthropic');
  // platform.claude.com/docs/en/api/errors: 402 billing_error, in the standard error body.
  const billing402 = {
    type: 'error',
    error: { type: 'billing_error', message: 'There is an issue with your billing or payment information.' },
    request_id: 'req_011CSHoEeqs5C35K2UUqR7Fy',
  };
  // Observed on a spent balance (not documented): a 400 invalid_request_error.
  const low400 = {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'Your credit balance is too low to access the Anthropic API.',
    },
  };

  it('is credit_exhausted on a key that draws on the monthly credit', () => {
    const a = classifyProviderError(anthropic, 402, billing402, undefined, undefined, '', {
      planCredit: true,
    });
    expect(a).toMatchObject({ kind: 'credit_exhausted', confirmed: true });
    const b = classifyProviderError(anthropic, 400, low400, undefined, undefined, '', { planCredit: true });
    expect(b).toMatchObject({ kind: 'credit_exhausted', confirmed: false });
  });

  it('stays no_credit on an ordinary key, and a rate limit is never read as spent credit', () => {
    expect(classifyProviderError(anthropic, 402, billing402).kind).toBe('no_credit');
    const rate = { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } };
    expect(
      classifyProviderError(anthropic, 429, rate, undefined, undefined, '', { planCredit: true }).kind,
    ).toBe('rate_limited');
  });

  it('is permanent (the chain moves on, nothing is retried) and has its own words', () => {
    expect(errorClassFor('credit_exhausted')).toBe('permanent');
    const w = failureWords('credit_exhausted', anthropic);
    expect(w?.code).toBe('provider.credit_exhausted');
    expect(w?.title).not.toMatch(/—/);
  });
});

describe('the registry and the monthly credit', () => {
  const sonnet = {
    id: 'anthropic/claude-sonnet-5-5',
    provider: 'anthropic',
    provider_model: 'claude-sonnet-5-5',
    display_name: 'Claude Sonnet 5.5',
    via: 'direct',
    family: 'claude',
    context_window: 200_000,
    max_output: 8_000,
    capabilities: ['tools'],
    price: { input_per_mtok: 3, output_per_mtok: 15 },
    enabled: true,
  } as ModelConfig;
  const ok = { installed: true, version_ok: true, verification: { state: 'verified' as const, error: null } };
  const max = { signed_in: true, auth_method: 'claude.ai', plan: 'Max' };

  const world = async (withKey: boolean) => {
    const secrets = new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64')));
    if (withKey) await secrets.set('ANTHROPIC_API_KEY', 'sk-ant-api03-TESTTESTTESTTEST');
    const reg = new ModelRegistry({
      models: [sonnet],
      taskClasses: { 'chat.default': ['claude-code/sonnet', 'anthropic/claude-sonnet-5-5'] },
      secrets,
      settings: new MemorySettings(),
      offline: false,
    });
    await reg.refresh();
    syncClaudeCodeModels(reg, { ...ok, ...max });
    return reg;
  };
  const byId = (reg: ModelRegistry, id: string) => reg.info().find((x) => x.id === id);

  it('offers a monthly-credit twin per Claude Code model, only once the key is marked', async () => {
    const reg = await world(true);
    const twins = claudeCodeModels().filter((m) => isCreditModel(m.id));
    expect(twins).toHaveLength(claudeCodeModels().length / 2);
    expect(byId(reg, 'claude-code/opus@credit')).toMatchObject({ status: 'disabled', listed: false });
    reg.setCredit({ enabled: true, exhausted: false, first: false });
    expect(byId(reg, 'claude-code/opus@credit')).toMatchObject({
      status: 'ready',
      listed: true,
      billing: { kind: 'credit', payer: PLAN_CREDIT_PAYER },
      secret: 'ANTHROPIC_API_KEY',
    });
    expect(byId(reg, 'claude-code/opus')?.billing).toEqual({ kind: 'plan', payer: 'max' });
    expect(byId(reg, 'anthropic/claude-sonnet-5-5')?.billing.kind).toBe('credit');
  });

  it('needs the Anthropic key, like any Anthropic model', async () => {
    const reg = await world(false);
    reg.setCredit({ enabled: true, exhausted: false, first: false });
    expect(byId(reg, 'claude-code/opus@credit')).toMatchObject({ status: 'needs_key', listed: false });
  });

  it('skips every model paid from the credit once Anthropic says it is spent, and flags them', async () => {
    const reg = await world(true);
    reg.setCredit({ enabled: true, exhausted: true, first: false });
    expect(byId(reg, 'claude-code/opus@credit')).toMatchObject({
      status: 'credit_out',
      credit_exhausted: true,
    });
    expect(byId(reg, 'anthropic/claude-sonnet-5-5')?.status).toBe('credit_out');
    expect(reg.chain('chat.default').map((m) => m.id)).toEqual(['claude-code/sonnet']);
    expect(byId(reg, 'claude-code/opus')?.status).toBe('ready');
  });

  it('puts the credit twin first only while the goal is on', async () => {
    const reg = await world(true);
    reg.setCredit({ enabled: true, exhausted: false, first: false });
    // The chain asks for the plan model, then the key model: both are Sonnet.
    expect(reg.chain('chat.default').map((m) => m.id)).toEqual([
      'claude-code/sonnet',
      'anthropic/claude-sonnet-5-5',
    ]);
    reg.setCredit({ enabled: true, exhausted: false, first: true });
    expect(reg.chain('chat.default').map((m) => m.id)).toEqual([
      'anthropic/claude-sonnet-5-5',
      'claude-code/sonnet',
    ]);
    // A model chosen for the message stays first.
    expect(reg.chain('chat.default', 'claude-code/sonnet').map((m) => m.id)[0]).toBe('claude-code/sonnet');
  });
});

describe('preferring credit models', () => {
  const m = (id: string, pm: string) => ({ id, provider_model: pm }) as ModelConfig;
  const plan = m('claude-code/opus', 'opus');
  const planSonnet = m('claude-code/sonnet', 'sonnet');
  const keyOpus = m('anthropic/claude-opus-5-5', 'claude-opus-5-5');
  const gpt = m('openai/gpt-5', 'gpt-5');
  const credit = (x: ModelConfig) => x.id.startsWith('anthropic/');

  it('moves a credit model ahead of an equal one, and leaves unequal ones alone', () => {
    expect(preferCreditFirst([planSonnet, plan, gpt, keyOpus], credit).map((x) => x.id)).toEqual([
      'claude-code/sonnet',
      'anthropic/claude-opus-5-5',
      'claude-code/opus',
      'openai/gpt-5',
    ]);
  });
  it('keeps a fixed head where it is', () => {
    expect(preferCreditFirst([plan, keyOpus], credit, 1).map((x) => x.id)).toEqual([
      'claude-code/opus',
      'anthropic/claude-opus-5-5',
    ]);
  });
});

describe('the key never reaches a log', () => {
  it('is not in the bridge own environment allow-list', () => {
    expect(BRIDGE_ENV.some((k) => /ANTHROPIC/i.test(k))).toBe(false);
  });

  it('is masked in an environment object and in text', () => {
    const key = 'sk-ant-api03-SECRETSECRETSECRET1234';
    const out = JSON.stringify(redact({ env: { ANTHROPIC_API_KEY: key, DISABLE_TELEMETRY: '1' } }));
    expect(out).not.toContain('SECRETSECRET');
    expect(redactText(`ANTHROPIC_API_KEY=${key} node bridge`)).not.toContain('SECRETSECRET');
    expect(redactText(`ANTHROPIC_API_KEY: ${key}`)).toBe(
      'ANTHROPIC_API_KEY=… node bridge'.replace(' node bridge', ''),
    );
  });
});
