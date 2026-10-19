/**
 * Who judges a fact-check when no model is set for it: Claude Code's
 * quickest model, then the smallest Ollama model you pulled; with none,
 * factcheck.no_model says each thing that was tried. Claude Code judges
 * run at most "fact-check judges at once" at a time (F1), each on its own.
 */
import { AncileError, type ModelConfig } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CLAUDE_CODE_JUDGE, JudgeSlots, judgeChain, structured } from '../../src/factcheck/steps';
import type { Gateway } from '../../src/gateway/gateway';
import { NoRouteError } from '../../src/gateway/router';

const model = (id: string, provider: string, provider_model = id): ModelConfig => ({
  id,
  provider,
  provider_model,
  display_name: id,
  via: 'direct',
  family: provider === 'claude_code' ? 'claude' : 'llama',
  context_window: 32_000,
  max_output: 4_000,
  capabilities: [],
  price: { input_per_mtok: 0, output_per_mtok: 0 },
  enabled: true,
});

function registry(models: ModelConfig[], chain: ModelConfig[] | null) {
  return {
    chain: (tc: string) => {
      if (!chain) throw new NoRouteError(tc);
      return chain;
    },
    all: () => models,
    status: () => 'ready' as const,
  };
}

describe('fact-check judges', () => {
  it('uses the chain set for the step when there is one', () => {
    const set = [model('openai/gpt-5', 'openai')];
    expect(judgeChain(registry([], set), 'factcheck.verify')).toBe(set);
  });

  it('with no model set, asks Claude Code, then a small pulled Ollama model', () => {
    const cc = model(CLAUDE_CODE_JUDGE, 'claude_code', 'haiku');
    const big = model('ollama/qwen3:32b', 'ollama', 'qwen3:32b');
    const small = model('ollama/llama3.2:3b', 'ollama', 'llama3.2:3b');
    const got = judgeChain(registry([big, cc, small], null), 'factcheck.verify');
    expect(got.map((m) => m.id)).toEqual([CLAUDE_CODE_JUDGE, 'ollama/llama3.2:3b']);
  });

  it('with nothing at all, says what was tried', () => {
    let err: unknown;
    try {
      judgeChain(registry([], null), 'utility');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AncileError);
    expect((err as AncileError).code).toBe('factcheck.no_model');
    expect((err as AncileError).hint).toMatch(/Claude Code/);
    expect((err as AncileError).hint).toMatch(/Ollama/);
    expect((err as AncileError).hint).toMatch(/Settings → Models/);
  });

  it('moves on to the next judge when Claude Code fails', async () => {
    const cc = model(CLAUDE_CODE_JUDGE, 'claude_code', 'haiku');
    const local = model('ollama/llama3.2:3b', 'ollama', 'llama3.2:3b');
    const asked: string[] = [];
    const gateway = {
      async *stream(chain: ModelConfig[]) {
        const m = chain[0] as ModelConfig;
        asked.push(m.id);
        if (m.provider === 'claude_code') throw new Error('Claude Code could not answer');
        yield { type: 'model', modelId: m.id };
        yield { type: 'chunk', chunk: { type: 'text', delta: '{"ok": true}' } };
      },
    } as unknown as Gateway;
    const out = await structured(
      { gateway },
      [cc, local],
      'check',
      z.object({ ok: z.boolean() }),
      new AbortController().signal,
    );
    expect(asked).toEqual([CLAUDE_CODE_JUDGE, 'ollama/llama3.2:3b']);
    expect(out).toEqual({ value: { ok: true }, modelId: 'ollama/llama3.2:3b' });
  });
});

/** A promise and the function that settles it. */
function gate() {
  let open = () => {};
  const shut = new Promise<void>((r) => {
    open = r;
  });
  return { shut, open };
}

describe('Claude Code judges at once', () => {
  it('runs one at a time by default; the others wait their turn, in order', async () => {
    const slots = new JudgeSlots(() => 1);
    const order: string[] = [];
    const gates = [gate(), gate(), gate()];
    const signal = new AbortController().signal;
    const runs = gates.map((g, k) =>
      slots.run(async () => {
        order.push(`start ${k}`);
        await g.shut;
        order.push(`end ${k}`);
        return k;
      }, signal),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(slots.load).toEqual({ running: 1, waiting: 2 });
    gates[0]?.open();
    gates[1]?.open();
    gates[2]?.open();
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
    expect(order).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
    expect(slots.load).toEqual({ running: 0, waiting: 0 });
  });

  it('runs as many as the setting allows, read as each call asks', async () => {
    let limit = 2;
    const slots = new JudgeSlots(async () => limit);
    let running = 0;
    let most = 0;
    const signal = new AbortController().signal;
    const job = () =>
      slots.run(async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
      }, signal);
    await Promise.all([job(), job(), job(), job()]);
    expect(most).toBe(2);
    limit = 4;
    most = 0;
    await Promise.all([job(), job(), job(), job()]);
    expect(most).toBe(4);
  });

  it('gives up a place in the queue when the fact-check stops, and keeps the last limit if the setting cannot be read', async () => {
    let fail = false;
    const slots = new JudgeSlots(async () => {
      if (fail) throw new Error('settings unreadable');
      return 1;
    });
    const first = gate();
    const live = new AbortController().signal;
    const holding = slots.run(() => first.shut, live);
    await Promise.resolve();
    const stop = new AbortController();
    fail = true;
    const waiting = slots.run(async () => 'never', stop.signal);
    await new Promise((r) => setTimeout(r, 0));
    expect(slots.load.waiting).toBe(1);
    stop.abort(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
    expect(slots.load).toEqual({ running: 1, waiting: 0 });
    first.open();
    await holding;
    // An already stopped fact-check never takes a slot.
    await expect(slots.run(async () => 1, stop.signal)).rejects.toThrow('stopped');
    expect(slots.load).toEqual({ running: 0, waiting: 0 });
  });

  it('asks a Claude Code judge on its own, through a slot, even when it is chosen after another model', async () => {
    const gpt = model('openai/gpt-5', 'openai');
    const cc = model('claude-code/sonnet', 'claude_code', 'sonnet');
    const asked: string[][] = [];
    const gateway = {
      async *stream(chain: ModelConfig[]) {
        asked.push(chain.map((m) => m.id));
        const m = chain[0] as ModelConfig;
        if (m.provider === 'openai') throw new Error('rate limited');
        yield { type: 'model', modelId: m.id };
        yield { type: 'chunk', chunk: { type: 'text', delta: '{"ok": true}' } };
      },
    } as unknown as Gateway;
    let calls = 0;
    const judges = new JudgeSlots(() => {
      calls += 1;
      return 1;
    });
    const out = await structured(
      { gateway, judges },
      [gpt, cc],
      'check',
      z.object({ ok: z.boolean() }),
      new AbortController().signal,
    );
    // The gateway is never handed Claude Code inside a fallback chain, where it would skip the slot.
    expect(asked).toEqual([['openai/gpt-5'], ['claude-code/sonnet']]);
    expect(calls).toBe(1);
    expect(out.modelId).toBe('claude-code/sonnet');
  });
});

describe('guard rail GR24 and the scope, in the judge search', () => {
  const claude = (id = 'anthropic/sonnet') => ({ ...model(id, 'anthropic'), family: 'claude' });
  const gpt = { ...model('openai/gpt', 'openai'), family: 'openai' };
  const local = { ...model('ollama/llama3.2:3b', 'ollama', 'llama3.2:3b'), family: 'llama' };

  it('never lets the writer family judge, and finds another family when there is one', () => {
    const got = judgeChain(registry([], [claude(), gpt]), 'factcheck.verify', {
      strict: true,
      generatorFamily: 'claude',
    });
    expect(got.map((m) => m.id)).toEqual(['openai/gpt']);
  });

  it('looks beyond the set chain for another family before giving up', () => {
    // Only the writer family is set, but a small local model of another family is ready.
    const got = judgeChain(registry([local], [claude()]), 'factcheck.verify', {
      strict: true,
      generatorFamily: 'claude',
    });
    expect(got.map((m) => m.id)).toEqual(['ollama/llama3.2:3b']);
  });

  it('with only the writer family ready, says so and offers nothing (no same-family fallback)', () => {
    let err: unknown;
    try {
      judgeChain(registry([], [claude()]), 'factcheck.verify', { strict: true, generatorFamily: 'claude' });
    } catch (e) {
      err = e;
    }
    expect((err as AncileError).code).toBe('factcheck.no_other_family');
    expect((err as AncileError).title).toBe('No second opinion is available');
    expect((err as AncileError).hint).toMatch(/claude model/);
    expect((err as AncileError).hint).toMatch(/Settings → Models/);
  });

  it('Claude Code writing the answer does not judge it', () => {
    const cc = model(CLAUDE_CODE_JUDGE, 'claude_code', 'haiku');
    expect(() =>
      judgeChain(registry([cc], null), 'factcheck.verify', { strict: true, generatorFamily: 'claude' }),
    ).toThrowError(/second opinion/);
  });

  it('your own words have no writer, so any family may judge', () => {
    const got = judgeChain(registry([], [claude()]), 'factcheck.verify', { strict: true });
    expect(got.map((m) => m.id)).toEqual(['anthropic/sonnet']);
  });

  it('keeps out what the scope keeps out, and says so when that is every judge', () => {
    const allow = (m: { id: string }) =>
      m.id === 'ollama/llama3.2:3b' ? null : 'Nothing may leave this machine here';
    expect(
      judgeChain(registry([local], [gpt]), 'factcheck.verify', { strict: true, allow }).map((m) => m.id),
    ).toEqual(['ollama/llama3.2:3b']);
    let err: unknown;
    try {
      judgeChain(registry([], [gpt]), 'factcheck.verify', { strict: true, allow });
    } catch (e) {
      err = e;
    }
    expect((err as AncileError).code).toBe('factcheck.judge_not_allowed');
    expect((err as AncileError).hint).toMatch(/Nothing may leave this machine here/);
  });

  it('names every model that failed when none could answer', async () => {
    const { ChainFailedError } = await import('../../src/gateway/gateway');
    const { chainFailure } = await import('../../src/factcheck/handler');
    const cc = model(CLAUDE_CODE_JUDGE, 'claude_code', 'haiku');
    const gateway = {
      stream(chain: ModelConfig[]) {
        const m = chain[0] as ModelConfig;
        throw m.provider === 'claude_code'
          ? new Error('Claude Code could not answer: plan limit reached')
          : new ChainFailedError([{ model: m.id, errorClass: 'transient', detail: 'connection refused' }]);
      },
    } as unknown as Gateway;
    let err: unknown;
    try {
      await structured(
        { gateway },
        [cc, local],
        'check',
        z.object({ ok: z.boolean() }),
        new AbortController().signal,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ChainFailedError);
    const f = chainFailure(err as InstanceType<typeof ChainFailedError>);
    expect(f.hint).toMatch(/claude-code\/haiku \(Claude Code could not answer: plan limit reached\)/);
    expect(f.hint).toMatch(/ollama\/llama3.2:3b \(connection refused\)/);
  });
});

describe('one name per family (GR24 is not fooled by a spelling)', () => {
  it("treats Claude Code's claude and the Anthropic API's anthropic as one family", async () => {
    const { canonicalFamily, familyFromModelId, sameFamily } = await import('../../src/factcheck/steps');
    expect(canonicalFamily('claude')).toBe('anthropic');
    expect(sameFamily('Anthropic', 'claude')).toBe(true);
    expect(sameFamily('openai', 'claude')).toBe(false);
    expect(sameFamily(null, 'claude')).toBe(false);
    expect(canonicalFamily('llama')).toBe('llama');
    expect(canonicalFamily(null)).toBeNull();
    // An answer written through the Anthropic API is not judged by Claude Code.
    const cc = model(CLAUDE_CODE_JUDGE, 'claude_code', 'haiku');
    expect(() =>
      judgeChain(registry([cc], null), 'factcheck.verify', { strict: true, generatorFamily: 'anthropic' }),
    ).toThrowError(/second opinion/);
    // A model the registry does not know (an engine's own name) still points at its family.
    expect(familyFromModelId('claude-sonnet-4-5')).toBe('anthropic');
    expect(familyFromModelId('claude-code/opus')).toBe('anthropic');
    expect(familyFromModelId('gpt-5')).toBe('openai');
    expect(familyFromModelId('gemini-2.5-pro')).toBe('google');
    expect(familyFromModelId('mystery')).toBeNull();
  });
});
