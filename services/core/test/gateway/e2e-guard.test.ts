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
  assertDirectCallAllowed,
  assertSendAllowed,
  claudeCodeBlocked,
  estimateCallUsd,
  installLiveGuard,
  installSendGuard,
  LIVE_CAP_DEFAULT_USD,
  liveGuardActive,
  liveSpentUsd,
  parseLiveAllow,
  parseLiveCap,
  resetSendGuard,
  sendGuardActive,
  testProfileActive,
} from '../../src/gateway/e2e-guard';
import { FakeProvider, fakeModel, OFFLINE_MODELS } from '../../src/gateway/fake';
import { ChainFailedError, Gateway } from '../../src/gateway/gateway';
import { languageModelFor } from '../../src/gateway/providers';
import { ModelRegistry, RoutingClient } from '../../src/gateway/registry';
import type { ModelClient, ModelRequest, StreamChunk } from '../../src/gateway/types';
import { MemorySecretStore, SecretBox } from '../../src/secrets';
import { MemorySettings } from '../../src/settings';

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

/* ---- LT1: live mode ------------------------------------------------------------------ */

const HAIKU = 'anthropic/claude-haiku-4-5';
const NODE = 'node/qwen2.5-1.5b';
const priced = (id: string, provider = 'anthropic'): ModelConfig => ({
  ...real(provider, id),
  max_output: 1_000,
  // $1 in, $5 out per million tokens: a 1,000-token answer is at most half a cent.
  price: { input_per_mtok: 1, output_per_mtok: 5 },
});

/** A client that answers with a fixed usage, and records who it was asked for. */
function billing(inputTokens: number, outputTokens: number, costUsd?: number) {
  const calls: string[] = [];
  const client: ModelClient = {
    async *stream(m): AsyncGenerator<StreamChunk> {
      calls.push(m.id);
      yield { type: 'text', delta: 'ok' };
      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens, outputTokens },
        ...(costUsd !== undefined && { costUsd }),
      };
    },
  };
  return { client, calls };
}

/** Run a chain to its end and give back the error it stopped with (null when it answered). */
async function chainError(gw: Gateway, chain: ModelConfig[], req: ModelRequest): Promise<unknown> {
  try {
    for await (const _ of gw.stream(chain, req, sig())) {
      // drained
    }
    return null;
  } catch (e) {
    return e;
  }
}

describe('live mode: reading the two variables', () => {
  it('splits the list on commas, trims, and drops empty and repeated ids', () => {
    expect(parseLiveAllow(` ${HAIKU} , ${NODE},, ${HAIKU} `)).toEqual([HAIKU, NODE]);
    expect(parseLiveAllow(undefined)).toEqual([]);
    expect(parseLiveAllow('  ')).toEqual([]);
  });

  it('takes a positive cap and falls back to 2 for anything else', () => {
    expect(parseLiveCap('0.5')).toBe(0.5);
    for (const bad of [undefined, '', 'abc', '0', '-3', 'NaN'])
      expect(parseLiveCap(bad)).toBe(LIVE_CAP_DEFAULT_USD);
    expect(LIVE_CAP_DEFAULT_USD).toBe(2);
  });

  it('is off without a list: nothing changes', () => {
    expect(installLiveGuard(undefined, '1')).toBe(false);
    expect(installLiveGuard('', undefined)).toBe(false);
    expect(liveGuardActive()).toBe(false);
    expect(sendGuardActive()).toBe(false);
    expect(claudeCodeBlocked()).toBe(false);
    expect(() => assertSendAllowed(real('anthropic'))).not.toThrow();
    expect(() => assertClaudeCodeAllowed()).not.toThrow();
    expect(() => assertDirectCallAllowed('an image')).not.toThrow();
  });

  it('is ignored beside the test profile, which allows nothing real', () => {
    installSendGuard('e2e');
    expect(installLiveGuard(HAIKU, '1')).toBe(false);
    expect(liveGuardActive()).toBe(false);
    expect(testProfileActive()).toBe(true);
    expect(() => assertSendAllowed(priced(HAIKU))).toThrow(/test profile/);
  });
});

describe('live mode: which models may be called', () => {
  const setup = () => {
    installLiveGuard(`${HAIKU},${NODE}`, '2');
    const sdk = spy('sdk');
    const fake = spy('fake');
    const own = spy('claude');
    const rc = new RoutingClient(sdk, fake);
    rc.register('claude_code', own);
    return { rc, sdk, fake, own };
  };

  it('turns the guard on without the test profile', () => {
    installLiveGuard(HAIKU, undefined);
    expect(liveGuardActive()).toBe(true);
    expect(sendGuardActive()).toBe(true);
    expect(testProfileActive()).toBe(false);
  });

  it('lets the listed models and the offline ones through, and nothing else', async () => {
    const { rc, sdk, fake } = setup();
    expect(await drain(rc.stream(priced(HAIKU), REQ, sig()))).toBe('sdk');
    expect(await drain(rc.stream({ ...priced(NODE, 'node'), via: 'controller' }, REQ, sig()))).toBe('sdk');
    expect(await drain(rc.stream(OFFLINE_MODELS[0] as ModelConfig, REQ, sig()))).toBe('fake');
    expect(sdk.calls).toEqual([HAIKU, NODE]);
    expect(fake.calls).toEqual(['offline/test']);
  });

  it.each([
    ['anthropic', 'anthropic/claude-sonnet-5-5'],
    ['openai', 'openai/gpt-x'],
    ['openrouter', 'openrouter/auto'],
    ['ollama', 'ollama/qwen3-14b'],
    ['node', 'node/some-other-node-model'],
    ['claude_code', 'claude-code/haiku'],
  ])('refuses %s (%s) before any client is asked', async (provider, id) => {
    const { rc, sdk, own, fake } = setup();
    const err = await drain(rc.stream(priced(id, provider), REQ, sig())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AncileError);
    expect((err as AncileError).code).toBe('e2e.real_model_blocked');
    expect((err as AncileError).title).toMatch(/live test run/);
    expect((err as AncileError).hint).toContain(HAIKU);
    expect([...sdk.calls, ...own.calls, ...fake.calls]).toEqual([]);
  });

  it('a model outside the list stops the chain; nothing falls through to a listed one', async () => {
    setup();
    const sdk = spy('sdk');
    const gw = new Gateway({
      client: new RoutingClient(sdk, new FakeProvider()),
      breaker: new CircuitBreaker(),
    });
    const err = await chainError(gw, [priced('anthropic/claude-sonnet-5-5'), priced(HAIKU)], REQ);
    expect(err).toBeInstanceOf(ChainFailedError);
    expect((err as ChainFailedError).attempts.map((a) => a.code)).toEqual(['e2e.real_model_blocked']);
    expect(sdk.calls).toEqual([]);
  });

  it('refuses the AI SDK entry point before reading a key', async () => {
    installLiveGuard(HAIKU, undefined);
    let read = false;
    const secrets = {
      get: async () => {
        read = true;
        return 'sk-test';
      },
    } as never;
    await expect(
      languageModelFor(priced('openai/gpt-x', 'openai'), secrets, {} as never),
    ).rejects.toMatchObject({ code: 'e2e.real_model_blocked' });
    expect(read).toBe(false);
  });

  it('refuses Claude Code: the bridge never launches, the CLI is never found (Mode A and Mode B)', async () => {
    installLiveGuard(HAIKU, undefined);
    expect(claudeCodeBlocked()).toBe(true);
    expect(() => assertClaudeCodeAllowed()).toThrow(/Claude Code/);
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

  it('refuses the direct calls that bypass the gateway (image providers, the Jev reviewers)', () => {
    installLiveGuard(HAIKU, undefined);
    expect(() => assertDirectCallAllowed('image generation')).toThrow(/live test run/);
  });
});

describe('live mode: the spending cap', () => {
  it('estimates a call at the whole prompt fresh plus a full answer', () => {
    const m = priced(HAIKU);
    const small = estimateCallUsd(m, { messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100 });
    const big = estimateCallUsd(m, {
      messages: [{ role: 'user', content: 'x'.repeat(40_000) }],
      maxOutputTokens: 100,
    });
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(0.001);
    // About 10,000 tokens in at $1 per million, plus 100 tokens out at $5.
    expect(big).toBeGreaterThan(0.0105);
    expect(big).toBeLessThan(0.0115);
  });

  it('adds up billed_usd where a provider said it, else the list price, across calls', async () => {
    installLiveGuard(HAIKU, '2');
    const rc = new RoutingClient(billing(1_000_000, 100_000).client, spy('fake'));
    expect(liveSpentUsd()).toBe(0);
    await drain(rc.stream(priced(HAIKU), REQ, sig()));
    // 1M in at $1, 100k out at $5.
    expect(liveSpentUsd()).toBeCloseTo(1.5, 6);

    const billed = new RoutingClient(billing(1_000_000, 100_000, 0.25).client, spy('fake'));
    await drain(billed.stream(priced(HAIKU), REQ, sig()));
    expect(liveSpentUsd()).toBeCloseTo(1.75, 6);
  });

  it('does not count the offline models', async () => {
    installLiveGuard(HAIKU, '2');
    const rc = new RoutingClient(spy('sdk'), billing(5_000_000, 5_000_000).client);
    await drain(rc.stream(OFFLINE_MODELS[0] as ModelConfig, REQ, sig()));
    expect(liveSpentUsd()).toBe(0);
  });

  it('refuses with live.cap_reached once the total plus the next estimate would pass the cap', async () => {
    installLiveGuard(HAIKU, '1');
    const { client, calls } = billing(900_000, 0); // $0.90 a call
    const rc = new RoutingClient(client, spy('fake'));
    await drain(rc.stream(priced(HAIKU), { ...REQ, maxOutputTokens: 10 }, sig()));
    expect(calls).toEqual([HAIKU]);
    const err = await drain(rc.stream(priced(HAIKU), { ...REQ, maxOutputTokens: 100_000 }, sig())).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AncileError);
    expect((err as AncileError).code).toBe('live.cap_reached');
    expect((err as AncileError).hint).toMatch(/ANCILE_LIVE_CAP_USD/);
    expect((err as AncileError).context).toMatchObject({ cap_usd: 1 });
    // Refused before anything was sent.
    expect(calls).toEqual([HAIKU]);
  });

  it('counts calls in flight, so two at once cannot both slip under the cap', async () => {
    installLiveGuard(HAIKU, '0.008');
    const rc = new RoutingClient(billing(1, 1).client, spy('fake'));
    const heavy: ModelRequest = { ...REQ, maxOutputTokens: 1_000 }; // estimated at $0.005
    const first = rc.stream(priced(HAIKU), heavy, sig())[Symbol.asyncIterator]();
    await first.next(); // started, and holding its reservation
    const err = await drain(rc.stream(priced(HAIKU), heavy, sig())).catch((e: unknown) => e);
    expect((err as AncileError).code).toBe('live.cap_reached');
    // Once the first call ends, its reservation is handed back and a new call fits.
    while (!(await first.next()).done) {
      // drained
    }
    expect(await drain(rc.stream(priced(HAIKU), heavy, sig()))).toBe('ok');
  });

  it('the cap error is not a fallback: the gateway stops the chain', async () => {
    installLiveGuard(`${HAIKU},${NODE}`, '0.001');
    const sdk = billing(1, 1);
    const gw = new Gateway({
      client: new RoutingClient(sdk.client, spy('fake')),
      breaker: new CircuitBreaker(),
    });
    const node: ModelConfig = { ...priced(NODE, 'node'), via: 'controller' };
    const err = await chainError(gw, [priced(HAIKU), node], { ...REQ, maxOutputTokens: 1_000 });
    expect((err as ChainFailedError).attempts.map((a) => a.code)).toEqual(['live.cap_reached']);
    expect(sdk.calls).toEqual([]);
  });
});

describe('live mode: a model asked for by name answers alone', () => {
  const world = async () => {
    const secrets = new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64')));
    await secrets.set('ANTHROPIC_API_KEY', 'sk-ant-api03-TESTTESTTESTTEST');
    const reg = new ModelRegistry({
      models: [priced(HAIKU), priced('anthropic/claude-sonnet-5-5')],
      taskClasses: { 'chat.default': ['anthropic/claude-sonnet-5-5', HAIKU] },
      secrets,
      settings: new MemorySettings(),
      offline: false,
    });
    await reg.refresh();
    return reg;
  };

  it('has a chain behind the model in the everyday stack', async () => {
    const reg = await world();
    expect(reg.chain('chat.default', HAIKU).map((m) => m.id)).toEqual([HAIKU, 'anthropic/claude-sonnet-5-5']);
  });

  it('has none in a live run, and says so when the model cannot answer', async () => {
    const reg = await world();
    installLiveGuard(HAIKU, undefined);
    expect(reg.chain('chat.default', HAIKU).map((m) => m.id)).toEqual([HAIKU]);
    expect(() => reg.chain('chat.default', 'anthropic/not-a-model')).toThrow(/No enabled model/);
    // Without a model asked for, the class chain is as it was.
    expect(reg.chain('chat.default').map((m) => m.id)).toEqual(['anthropic/claude-sonnet-5-5', HAIKU]);
  });
});
