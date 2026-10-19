import { describe, expect, it } from 'vitest';
import {
  checkReview,
  condense,
  HINDSIGHT_INPUT_TOKENS,
  HINDSIGHT_MAX_ITEMS,
  HindsightReview,
  type Turn,
  turnsOf,
} from '../../src/memory/hindsight';
import { approxTokens } from '../../src/memory/inject';
import type { MessageRecord } from '../../src/threads/repo';

const turn = (n: number, over: Partial<Turn> = {}): Turn => ({
  n,
  messageId: `msg_${n}`,
  user: `question ${n}`,
  assistant: `answer ${n}`,
  tools: [],
  ...over,
});

const msg = (id: string, role: 'user' | 'assistant', parts: MessageRecord['parts']): MessageRecord =>
  ({ id, role, parts, thread_id: 't', parent_id: null, status: 'complete' }) as unknown as MessageRecord;

describe('turnsOf', () => {
  it('cuts a path into numbered turns with their tool outcomes', () => {
    const turns = turnsOf([
      msg('u1', 'user', [{ type: 'text', text: 'hello' }]),
      msg('a1', 'assistant', [
        { type: 'tool_call', call_id: 'c', tool: 'fs_read', args: {} },
        { type: 'tool_result', call_id: 'c', ok: false, result: 'ENOENT\nmore' },
        { type: 'text', text: 'sorry' },
      ]),
      msg('u2', 'user', [{ type: 'text', text: 'again' }]),
    ]);
    expect(turns.map((t) => [t.n, t.messageId])).toEqual([
      [1, 'a1'],
      [2, 'u2'],
    ]);
    expect(turns[0]?.tools).toEqual(['fs_read failed: ENOENT']);
  });
});

describe('condense: long sessions are summarised first, under a cap', () => {
  it('shows a short session whole', () => {
    const c = condense([turn(1), turn(2)]);
    expect(c.summarised).toBe(false);
    expect(c.shown).toEqual([1, 2]);
    expect(c.text).toContain('Turn 2');
  });

  it('trims every turn when the session is a little too long', () => {
    const turns = Array.from({ length: 40 }, (_, i) =>
      turn(i + 1, { user: 'u'.repeat(900), assistant: 'a'.repeat(900) }),
    );
    const c = condense(turns, 4_000);
    expect(c.summarised).toBe(true);
    expect(c.shown).toHaveLength(40);
    expect(approxTokens(c.text)).toBeLessThanOrEqual(4_000);
  });

  it('leaves the quiet turns out of a huge session, keeping the first, the last two and the trouble', () => {
    const turns = Array.from({ length: 600 }, (_, i) =>
      turn(i + 1, { user: 'x'.repeat(400), assistant: 'y'.repeat(400) }),
    );
    turns[299] = turn(300, { tools: ['fs_read failed: ENOENT'] });
    const c = condense(turns);
    expect(c.summarised).toBe(true);
    expect(approxTokens(c.text)).toBeLessThanOrEqual(HINDSIGHT_INPUT_TOKENS);
    expect(c.shown).toEqual(expect.arrayContaining([1, 299 + 1, 599, 600]));
    expect(c.shown.length).toBeLessThan(600);
    expect(c.text).toMatch(/quiet turns? left out/);
  });
});

describe('checkReview: the model cannot invent a lesson', () => {
  const turns = [turn(1), turn(2), turn(3)];
  const item = (over: Record<string, unknown>) => ({
    kind: 'process_lesson' as const,
    topic: 't',
    root_cause: 'x',
    text: 'Check the path first.',
    turn: 2,
    confidence: 0.7,
    ...over,
  });
  const review = (items: unknown[]) =>
    HindsightReview.parse({ nothing_worth_keeping: false, note: '', items });

  it('keeps an item that cites a turn it was shown, with that turn’s message', () => {
    const r = checkReview(review([item({})]), turns, [1, 2, 3]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ messageId: 'msg_2' });
    expect(r.dropped).toBe(0);
  });

  it('drops an item with no real turn, one not shown, an empty one and a repeat', () => {
    const r = checkReview(
      review([
        item({ turn: 9 }),
        item({ turn: 3 }),
        item({ text: '   ' }),
        item({ text: 'Same thing.' }),
        item({ text: 'same thing.' }),
      ]),
      turns,
      [1, 2],
    );
    expect(r.items.map((i) => i.text)).toEqual(['Same thing.']);
    expect(r.dropped).toBe(4);
  });

  it('files at most a handful', () => {
    const many = Array.from({ length: 12 }, (_, i) => item({ text: `Lesson ${i}.` }));
    expect(checkReview(review(many), turns, [1, 2, 3]).items).toHaveLength(HINDSIGHT_MAX_ITEMS);
  });

  it('reads a review that says nothing', () => {
    expect(HindsightReview.parse({ nothing_worth_keeping: true })).toMatchObject({ items: [], note: '' });
  });
});
