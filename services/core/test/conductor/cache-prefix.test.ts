/**
 * ------------------------------------------------------------------
 *  Title    |  A prompt whose start stays the same
 *  Ref      |  docs/engines.md (Context for each engine)
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  Providers' prompt caches (Anthropic, OpenAI, vLLM's
 *           |  prefix cache, Ollama's KV cache) hold only while the
 *           |  start of the prompt is the same. Measured live: a clock
 *           |  to the minute in the system prompt, and the turn's
 *           |  passages there too, left nothing cached between turns.
 * ------------------------------------------------------------------
 */

import { FULL_CONTEXT } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import {
  LATEST_QUESTION,
  REFERENCE_HEADER,
  systemPrompt,
  withTurnContext,
} from '../../src/conductor/context';
import { assemble } from '../../src/flows/context';
import type { ModelMessage } from '../../src/gateway/types';

describe('a cache-friendly prompt', () => {
  it('gives the system prompt the date only, so it is the same all day', async () => {
    const at = (iso: string) =>
      systemPrompt({ promptsDir: '/nowhere', model: undefined, tools: false, now: new Date(iso) });
    const morning = await at('2026-10-12T08:01:00Z');
    expect(morning).toBe(await at('2026-10-12T21:59:59Z'));
    expect(morning).toContain('2026-10-12');
    expect(morning).not.toContain('08:01');
  });

  it("puts this turn's passages on the question, leaving earlier turns untouched", () => {
    const history: ModelMessage[] = [
      { role: 'user', content: 'first', parts: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second', parts: [{ type: 'text', text: 'second' }] },
    ];
    const out = withTurnContext(history, 'Sources:\n[1] passage');
    expect(out.slice(0, 2)).toEqual(history.slice(0, 2));
    const lead = `${REFERENCE_HEADER}\n\nSources:\n[1] passage\n\n---\n\n${LATEST_QUESTION}\n\n`;
    expect(out[2]?.content).toBe(`${lead}second`);
    expect(out[2]?.parts?.[0]).toEqual({ type: 'text', text: lead });
    expect(out[2]?.parts?.[1]).toEqual({ type: 'text', text: 'second' });
    // A later tool round keeps the passages on the same question.
    const round2 = withTurnContext([...history, { role: 'assistant', content: 'calling a tool' }], 'S');
    expect(round2[2]?.content).toBe(`${REFERENCE_HEADER}\n\nS\n\n---\n\n${LATEST_QUESTION}\n\nsecond`);
    expect(withTurnContext(history, '')).toBe(history);
  });

  it('labels the passages as reference material, and the latest question comes last', () => {
    const history: ModelMessage[] = [
      { role: 'user', content: 'What is the pump speed?' },
      { role: 'assistant', content: '1,450 rpm.' },
      { role: 'user', content: 'And its flow rate?' },
    ];
    const out = withTurnContext(history, 'Sources:\n[1] Pump P-101 runs at 1,450 rpm and moves 40 m3/h.');
    const text = out.at(-1)?.content ?? '';
    expect(out.at(-1)?.role).toBe('user');
    expect(text.startsWith(REFERENCE_HEADER)).toBe(true);
    // Nothing follows the question: it is the last thing the model reads.
    expect(text.endsWith(`${LATEST_QUESTION}\n\nAnd its flow rate?`)).toBe(true);
    expect(text.indexOf('Sources:')).toBeLessThan(text.indexOf(LATEST_QUESTION));
    expect(out[0]).toEqual(history[0]);
    expect(text).not.toContain('What is the pump speed?');
  });

  it("keeps a flow step's passages out of its system prompt too", async () => {
    const p = await assemble({
      policy: FULL_CONTEXT,
      role: 'You check budgets.',
      input: 'Is it compliant?',
      upstream: [],
      src: {
        conversation: async () => [{ role: 'user', content: 'earlier' }],
        sources: async () => '[1] budget\n"""\nGBP 452,300\n"""',
        memory: async () => 'memory',
      },
    });
    expect(p.system).toBe('You check budgets.\n\nmemory');
    expect(p.messages.at(-1)?.content).toBe('[1] budget\n"""\nGBP 452,300\n"""\n\n---\n\nIs it compliant?');
  });
});
