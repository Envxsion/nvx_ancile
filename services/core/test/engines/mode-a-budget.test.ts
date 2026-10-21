/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code as a model gets a budget, not the branch
 *  Ref      |  engines/mode-a.ts · flows/execute.ts (WORKER_CONTEXT)
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  Found live: a Claude manager flow used 71.7k tokens for
 *           |  one answer, since every call is a fresh session given
 *           |  the whole thread, and an error read "(success)". Now
 *           |  the prompt is cut to a budget, the window is one a
 *           |  thread compacts to, errors say plainly what happened,
 *           |  and flow workers default to the last few turns.
 * ------------------------------------------------------------------
 */

import { describe, expect, it } from 'vitest';
import {
  claudeCodeModels,
  errorResult,
  MODE_A_PROMPT_TOKENS,
  MODE_A_WINDOW,
  promptOf,
} from '../../src/engines/mode-a';
import { stepBudget, WORKER_CONTEXT } from '../../src/flows/execute';
import type { ModelMessage } from '../../src/gateway/types';

const turn = (i: number): ModelMessage[] => [
  { role: 'user', content: `question ${i} ${'x'.repeat(4_000)}` },
  { role: 'assistant', content: `answer ${i} ${'y'.repeat(4_000)}` },
];

describe('Claude Code as a model', () => {
  it('sends the latest message and only the turns that fit the budget', () => {
    const messages = [
      ...Array.from({ length: 60 }, (_, i) => turn(i)).flat(),
      { role: 'user' as const, content: 'latest?' },
    ];
    const prompt = promptOf({ messages });
    expect(Math.ceil(prompt.length / 4)).toBeLessThanOrEqual(MODE_A_PROMPT_TOKENS + 100);
    expect(prompt.endsWith('latest?')).toBe(true);
    expect(prompt).toContain('answer 59');
    expect(prompt).not.toContain('question 0 ');
    expect(prompt).toMatch(/\(\d+ earlier messages did not fit here and are left out\./);
    expect(prompt).toContain('do not guess what they said');
  });

  it('keeps a short conversation whole', () => {
    const prompt = promptOf({ messages: [...turn(1), { role: 'user', content: 'and then?' }] });
    expect(prompt).toContain('question 1');
    expect(prompt).not.toContain('left out');
  });

  it('has a window threads and flow steps budget to', () => {
    for (const m of claudeCodeModels()) expect(m.context_window).toBe(MODE_A_WINDOW);
    const [m] = claudeCodeModels();
    expect(stepBudget(m as never)).toBeLessThan(MODE_A_WINDOW);
  });

  it('never says "success" for an error, and tells a too-long prompt from what was sent', () => {
    expect(errorResult({ subtype: 'success', is_error: true }, 1_500).message).toBe(
      'Claude Code could not answer and gave no reason.',
    );
    const long = errorResult(
      { subtype: 'success', is_error: true, result: 'Prompt is too long: ~283k tokens' },
      6_000,
    );
    expect(long.message).toContain('NVX Ancile sent it about 6k tokens');
    expect(long.message).not.toContain('(success)');
  });
});

describe('a flow worker', () => {
  it('defaults to the last few turns and the passages, not the whole branch', () => {
    expect(WORKER_CONTEXT.conversation).toEqual({ mode: 'last_n', n: 4 });
    expect(WORKER_CONTEXT.sources.mode).toBe('retrieved');
  });
});
