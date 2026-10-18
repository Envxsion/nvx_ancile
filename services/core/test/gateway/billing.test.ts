/**
 * Who pays for a model (MD3): a plan, a key, your computer, a rented node,
 * or nothing. Claude Code's models follow how it is signed in.
 */
import type { ModelConfig } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { claudeCodeModels, syncClaudeCodeModels } from '../../src/engines/mode-a';
import { billingOf } from '../../src/gateway/billing';
import { ModelRegistry } from '../../src/gateway/registry';
import { MemorySecretStore, SecretBox } from '../../src/secrets';
import { MemorySettings } from '../../src/settings';

const m = (p: Partial<ModelConfig> & Pick<ModelConfig, 'provider'>) => ({
  via: 'direct' as const,
  ...p,
});
const max = { signed_in: true, auth_method: 'claude.ai', plan: 'Max' };

describe('billingOf', () => {
  it('Claude Code on a subscription is a plan, named as Claude Code names it', () => {
    expect(billingOf(m({ provider: 'claude_code' }), max)).toEqual({ kind: 'plan', payer: 'max' });
  });
  it('Claude Code with an unknown sign-in is a plan with no name', () => {
    expect(billingOf(m({ provider: 'claude_code' }), null)).toEqual({ kind: 'plan', payer: null });
    expect(billingOf(m({ provider: 'claude_code' }), { ...max, plan: null })).toEqual({
      kind: 'plan',
      payer: null,
    });
  });
  it('Claude Code on an API key or a cloud account is pay per use', () => {
    for (const [method, payer] of [
      ['api_key', 'anthropic'],
      ['apiKey', 'anthropic'],
      ['bedrock', 'bedrock'],
      ['vertex', 'vertex'],
      ['foundry', 'foundry'],
    ] as const)
      expect(billingOf(m({ provider: 'claude_code' }), { ...max, auth_method: method })).toEqual({
        kind: 'key',
        payer,
      });
  });
  it('offline test models cost nothing', () => {
    expect(billingOf(m({ provider: 'fake' }), null)).toEqual({ kind: 'none', payer: null });
  });
  it('Ollama, your network and GPU nodes on it are local', () => {
    expect(billingOf(m({ provider: 'ollama' }), null).kind).toBe('local');
    expect(billingOf(m({ provider: 'controller', via: 'controller' }), null).kind).toBe('local');
    expect(billingOf(m({ provider: 'node', via: 'controller', runs_on: 'your_network' }), null).kind).toBe(
      'local',
    );
    expect(billingOf(m({ provider: 'custom', base_url: 'http://127.0.0.1:8000/v1' }), null).kind).toBe(
      'local',
    );
    expect(billingOf(m({ provider: 'custom', base_url: 'http://192.168.1.5:8000/v1' }), null).kind).toBe(
      'local',
    );
  });
  it('a rented node is billed by the hour', () => {
    expect(billingOf(m({ provider: 'node', via: 'controller', runs_on: 'rented' }), null)).toEqual({
      kind: 'rented',
      payer: null,
    });
  });
  it('everything else is a key, billed by its provider', () => {
    expect(billingOf(m({ provider: 'anthropic' }), max)).toEqual({ kind: 'key', payer: 'anthropic' });
    expect(billingOf(m({ provider: 'openrouter' }), null)).toEqual({ kind: 'key', payer: 'openrouter' });
    expect(billingOf(m({ provider: 'custom', base_url: 'https://api.example.com/v1' }), null)).toEqual({
      kind: 'key',
      payer: 'custom',
    });
  });
});

describe('the registry says who pays', () => {
  const world = async () => {
    const registry = new ModelRegistry({
      models: [],
      taskClasses: {},
      secrets: new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64'))),
      settings: new MemorySettings(),
      offline: true,
    });
    await registry.refresh();
    return registry;
  };
  const ok = { installed: true, version_ok: true, verification: { state: 'verified' as const, error: null } };

  it('labels Claude Code by its plan and the test models as free', async () => {
    const reg = await world();
    syncClaudeCodeModels(reg, { ...ok, ...max });
    const info = reg.info();
    const opus = info.find((x) => x.id === 'claude-code/opus');
    expect(opus?.billing).toEqual({ kind: 'plan', payer: 'max' });
    expect(opus?.status).toBe('ready');
    expect(info.find((x) => x.provider === 'fake')?.billing.kind).toBe('none');
  });

  it('keeps Claude Code models as signed_out, and never routes to them, while signed out', async () => {
    const reg = await world();
    syncClaudeCodeModels(reg, { ...ok, signed_in: false, auth_method: null, plan: null });
    const cc = reg.info().filter((x) => x.provider === 'claude_code');
    expect(cc).toHaveLength(claudeCodeModels().length);
    expect(cc.every((x) => x.status === 'signed_out')).toBe(true);
    expect(reg.chain('chat.default', 'claude-code/opus').map((x) => x.id)).not.toContain('claude-code/opus');
    syncClaudeCodeModels(reg, { ...ok, ...max });
    expect(reg.info().find((x) => x.id === 'claude-code/opus')?.status).toBe('ready');
  });

  it('bills Claude Code to the key when it is signed in with one', async () => {
    const reg = await world();
    syncClaudeCodeModels(reg, { ...ok, signed_in: true, auth_method: 'api_key', plan: null });
    expect(reg.info().find((x) => x.id === 'claude-code/opus')?.billing).toEqual({
      kind: 'key',
      payer: 'anthropic',
    });
  });
});
