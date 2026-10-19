/**
 * The test profile's send guard: in ANCILE_PROFILE=e2e nothing reaches a real model (keyed providers,
 * OpenRouter, Ollama, Claude Code); in dev and production nothing changes. No network, no CLI.
 */
import { AncileError, type ModelConfig } from '@nvx/contracts';
import { CircuitBreaker } from '@nvx/resilience';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeClient } from '../../src/claudecode/bridge';
import { ClaudeCli } from '../../src/claudecode/cli';
import {
  assertClaudeCodeAllowed,
  assertSendAllowed,
  installSendGuard,
  resetSendGuard,
  sendGuardActive,
} from '../../src/gateway/e2e-guard';
import { FakeProvider, fakeModel, OFFLINE_MODELS } from '../../src/gateway/fake';
import { ChainFailedError, Gateway } from '../../src/gateway/gateway';
import { languageModelFor } from '../../src/gateway/providers';
import { RoutingClient } from '../../src/gateway/registry';
import type { ModelClient, ModelRequest, StreamChunk } from '../../src/gateway/types';

const real = (provider: string, id = `${provider}/x`): ModelConfig => ({
  ...fakeModel('x', 'echo'),
  id,
  provider,
  provider_model: 'x',
  family: provider,
});
const REQ: ModelRequest = { messages: [{ role: 'user', content: 'hi' }] };
const sig = () => new AbortController().signal;

/** A client that records what it was asked and answers with its label. */
function spy(label: string): ModelClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async *stream(m): AsyncGenerator<StreamChunk> {
      calls.push(m.id);
      yield { type: 'text', delta: label };
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

async function drain(it: AsyncIterable<StreamChunk>): Promise<string> {
  let text = '';
  for await (const c of it) if (c.type === 'text') text += c.delta;
  return text;
}

afterEach(() => resetSendGuard());

describe('the guard is only on in the test profile', () => {
  it('installs for e2e and for nothing else', () => {
    expect(installSendGuard('e2e')).toBe(true);
    expect(sendGuardActive()).toBe(true);
    expect(installSendGuard('dev')).toBe(false);
    expect(installSendGuard(undefined)).toBe(false);
    expect(sendGuardActive()).toBe(false);
  });
});

describe('RoutingClient in the dev profile', () => {
  it('lets every provider through', async () => {
    const sdk = spy('sdk');
    const own = spy('claude');
    const rc = new RoutingClient(sdk, spy('fake'));
    rc.register('claude_code', own);
    expect(await drain(rc.stream(real('anthropic'), REQ, sig()))).toBe('sdk');
    expect(await drain(rc.stream(real('claude_code'), REQ, sig()))).toBe('claude');
    expect(sdk.calls).toEqual(['anthropic/x']);
    expect(own.calls).toEqual(['claude_code/x']);
  });
});

describe('RoutingClient in the e2e profile', () => {
  const setup = () => {
    installSendGuard('e2e');
    const sdk = spy('sdk');
    const fake = spy('fake');
    const own = spy('claude');
    const rc = new RoutingClient(sdk, fake);
    rc.register('claude_code', own);
    return { rc, sdk, fake, own };
  };

  it.each([
    'anthropic',
    'openai',
    'google',
    'openrouter',
    'ollama',
    'local',
    'openai-compatible',
    'claude_code',
  ])('refuses %s before any client is asked', async (provider) => {
    const { rc, sdk, own, fake } = setup();
    const err = await drain(rc.stream(real(provider), REQ, sig())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AncileError);
    expect((err as AncileError).code).toBe('e2e.real_model_blocked');
    expect((err as AncileError).hint).toMatch(/offline/i);
    expect([...sdk.calls, ...own.calls, ...fake.calls]).toEqual([]);
  });

  it('allows the offline models and fake models', async () => {
    const { rc, fake } = setup();
    for (const m of [...OFFLINE_MODELS, fakeModel('anything', 'script')])
      expect(await drain(rc.stream(m, REQ, sig()))).toBe('fake');
    expect(fake.calls).toHaveLength(OFFLINE_MODELS.length + 1);
  });

  it('allows a Controller node (the profile forces the Controller to its fake provider)', async () => {
    const { rc, sdk } = setup();
    const node: ModelConfig = { ...real('openai-compatible', 'node/llama'), via: 'controller' };
    expect(await drain(rc.stream(node, REQ, sig()))).toBe('sdk');
    expect(sdk.calls).toEqual(['node/llama']);
  });
});

describe('the gateway stops the chain instead of falling back', () => {
  it('a real model first, then an offline one: refused with the code, and nothing falls through', async () => {
    installSendGuard('e2e');
    const sdk = spy('sdk');
    const gw = new Gateway({
      client: new RoutingClient(sdk, new FakeProvider()),
      breaker: new CircuitBreaker(),
    });
    const chain = [real('anthropic', 'anthropic/claude'), OFFLINE_MODELS[0] as ModelConfig];
    const run = async () => {
      for await (const _ of gw.stream(chain, REQ, sig())) {
        // drained
      }
    };
    const err = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ChainFailedError);
    const attempts = (err as ChainFailedError).attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.code).toBe('e2e.real_model_blocked');
    expect(sdk.calls).toEqual([]);
  });

  it('an offline model answers as usual', async () => {
    installSendGuard('e2e');
    const gw = new Gateway({
      client: new RoutingClient(spy('sdk'), spy('offline')),
      breaker: new CircuitBreaker(),
    });
    let text = '';
    for await (const e of gw.stream([OFFLINE_MODELS[1] as ModelConfig], REQ, sig()))
      if (e.type === 'chunk' && e.chunk.type === 'text') text += e.chunk.delta;
    expect(text).toBe('offline');
  });
});

describe('the AI SDK entry point (also behind "test this key")', () => {
  it('refuses a real model before reading its key', async () => {
    installSendGuard('e2e');
    let read = false;
    const secrets = {
      get: async () => {
        read = true;
        return 'sk-test';
      },
    } as never;
    await expect(languageModelFor(real('openai'), secrets, {} as never)).rejects.toMatchObject({
      code: 'e2e.real_model_blocked',
    });
    expect(read).toBe(false);
  });

  it('is untouched in dev', async () => {
    const secrets = { get: async () => 'sk-test' } as never;
    expect(await languageModelFor(real('openai'), secrets, {} as never)).toBeTruthy();
  });
});

describe('Claude Code itself', () => {
  it('is silent in dev and loud in e2e', () => {
    expect(() => assertSendAllowed(real('anthropic'))).not.toThrow();
    expect(() => assertClaudeCodeAllowed()).not.toThrow();
    installSendGuard('e2e');
    expect(() => assertSendAllowed(real('anthropic'))).toThrow(/test profile/);
    expect(() => assertClaudeCodeAllowed()).toThrow(/Claude Code/);
  });

  it('the CLI is never found, and the bridge never starts', async () => {
    installSendGuard('e2e');
    expect(new ClaudeCli().where()).toBeNull();
    let launched = 0;
    const bridge = new BridgeClient({
      launch: async () => {
        launched++;
        throw new Error('must not launch');
      },
    });
    await expect(bridge.listSessions()).rejects.toMatchObject({ code: 'e2e.real_model_blocked' });
    expect(launched).toBe(0);
  });
});
