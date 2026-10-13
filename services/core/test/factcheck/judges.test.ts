/**
 * Who judges a fact-check when no model is set for it: Claude Code's
 * quickest model, then the smallest Ollama model you pulled; with none,
 * factcheck.no_model says each thing that was tried.
 */
import { AncileError, type ModelConfig } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CLAUDE_CODE_JUDGE, judgeChain, structured } from '../../src/factcheck/steps';
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
