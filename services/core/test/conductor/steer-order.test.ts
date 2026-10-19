/**
 * ------------------------------------------------------------------
 *  Title    |  Where a steering note sits (CH7)
 *  Ref      |  ROADMAP.md CH7 · conductor/context.ts (spliceNotes)
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  A note stays where it was taken: after the work done
 *           |  before it and before the work that followed. Each
 *           |  request starts with the bytes of the one before, and a
 *           |  later turn sends a steered answer as its last round did
 *           |  (CA4).
 * ------------------------------------------------------------------
 */

import type { Message, Part, SteeredNote } from '@nvx/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { historyFor, spliceNotes } from '../../src/conductor/context';
import { noteMessage, SteerBus } from '../../src/conductor/steer';
import { toSdkMessages } from '../../src/gateway/convert';
import type { ModelMessage } from '../../src/gateway/types';
import { type Harness, harness } from '../support/harness';

vi.setConfig({ testTimeout: 15_000 });

const call = (n: number): Part => ({ type: 'tool_call', call_id: `c${n}`, tool: 't', args: { n } });
const result = (n: number): Part => ({ type: 'tool_result', call_id: `c${n}`, ok: true, result: n });
const note = (id: string, text: string, part: number | undefined, round: number): SteeredNote => ({
  id,
  text,
  round,
  ...(part !== undefined && { part }),
  at: '',
});

describe('putting notes back in place', () => {
  const parts: Part[] = [call(1), result(1), call(2), result(2), call(3), result(3)];

  it('cuts the work at each note, in order, and skips empty slices', () => {
    const out = spliceNotes(parts, [note('b', 'second', 4, 2), note('a', 'first', 2, 1)]);
    expect(out.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(out.map((m) => m.parts?.length ?? 0)).toEqual([2, 0, 2, 0, 2]);
    expect(out[1]?.content).toBe(noteMessage('first'));
    expect(out[3]?.content).toBe(noteMessage('second'));
    // Before any work: right after the question, and no empty answer in front of it.
    expect(spliceNotes(parts, [note('a', 'early', 0, 0)]).map((m) => m.role)).toEqual(['user', 'assistant']);
    // Two notes at one boundary stay in the order they were taken.
    expect(
      spliceNotes(parts, [note('a', 'one', 2, 1), note('b', 'two', 2, 1)]).map((m) => m.content),
    ).toEqual([expect.any(String), noteMessage('one'), noteMessage('two'), expect.any(String)]);
    // Older answers kept no position: the note sits after the work, as it used to.
    expect(spliceNotes(parts, [note('a', 'old', undefined, 1)]).map((m) => m.role)).toEqual([
      'assistant',
      'user',
    ]);
  });
});

describe('through several rounds and a later turn', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  const bytes = (messages: ModelMessage[]) =>
    toSdkMessages(messages, { tools: true }).map((m) => JSON.stringify(m));
  const isPrefix = (a: string[], b: string[]) => a.length <= b.length && a.every((x, i) => x === b[i]);
  const shape = (messages: ModelMessage[]) =>
    messages.map((m) => (m.role === 'user' && m.content.includes('<user_note>') ? 'note' : m.role));

  /** What the provider receives: roles in order, tool messages folded into the work, notes named. */
  const sdkShape = (messages: ModelMessage[]) =>
    toSdkMessages(messages, { tools: true })
      .map((m) =>
        m.role === 'user' && JSON.stringify(m.content).includes('<user_note>')
          ? 'note'
          : m.role === 'tool'
            ? 'assistant'
            : m.role,
      )
      .filter((x, i, all) => x !== all[i - 1]);

  async function steeredTurn() {
    const steer = new SteerBus();
    const take = steer.take.bind(steer);
    const offered = new Set<number>();
    steer.take = (thread, message, round) => {
      // One note as the model reaches round 1 and another as it reaches round 3.
      if ((round === 1 || round === 3) && !offered.has(round)) {
        offered.add(round);
        steer.offer(thread, `note at round ${round}`);
      }
      return take(thread, message, round);
    };
    h = await harness({ steer });
    const t = await h.newThread();
    const first = await h.send(t, '/loop fs_list {"path":"/workspace"}');
    expect((await h.settle(first.run_id)).status).toBe('succeeded');
    const requests = h.provider.calls.map((c) => c.req);
    return { t, first, requests };
  }

  it('keeps each note between the work before it and the work after it', async () => {
    const { requests, first } = await steeredTurn();
    const sig = (i: number) => shape(requests[i]?.messages ?? []).join(' ');
    expect(sig(0)).toBe('user');
    expect(sig(1)).toBe('user assistant note');
    expect(sig(2)).toBe('user assistant note assistant');
    expect(sig(3)).toBe('user assistant note assistant note');
    expect(sig(4)).toBe('user assistant note assistant note assistant');
    const answer = (await h.repo.getMessage(first.assistant_message_id)) as Message;
    expect(answer.provenance.steered).toEqual([
      expect.objectContaining({ round: 1, part: 3 }),
      expect.objectContaining({ round: 3, part: 9 }),
    ]);
  });

  it("starts each round's request with every byte of the one before", async () => {
    const { requests } = await steeredTurn();
    expect(requests.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < requests.length; i++)
      expect(
        isPrefix(bytes(requests[i - 1]?.messages ?? []), bytes(requests[i]?.messages ?? [])),
        `request ${i} extends request ${i - 1}`,
      ).toBe(true);
  });

  it('shows a later turn the notes where they were, and sends the answer as its last round did', async () => {
    const { t, first, requests } = await steeredTurn();
    const last = bytes(requests.at(-1)?.messages ?? []);
    const second = await h.send(t, '/say thanks', { parent_id: first.assistant_message_id });
    await h.settle(second.run_id);
    const later = h.provider.calls.at(-1)?.req.messages ?? [];
    expect(sdkShape(later)).toEqual(['user', 'assistant', 'note', 'assistant', 'note', 'assistant', 'user']);
    expect(isPrefix(last, bytes(later))).toBe(true);
  });

  it('rebuilds the same bytes when no sent form was stored', async () => {
    const { t, first, requests } = await steeredTurn();
    const last = bytes(requests.at(-1)?.messages ?? []);
    await h.repo.updateMessage(first.assistant_message_id, { sent: null });
    const second = await h.send(t, '/say thanks', { parent_id: first.assistant_message_id });
    await h.settle(second.run_id);
    const later = h.provider.calls.at(-1)?.req.messages ?? [];
    expect(sdkShape(later)).toEqual(['user', 'assistant', 'note', 'assistant', 'note', 'assistant', 'user']);
    expect(isPrefix(last, bytes(later))).toBe(true);
    // The history builder alone does the same from provenance.
    const rebuilt = historyFor(await h.repo.messages(t), second.user_message_id);
    expect(shape(rebuilt).filter((x) => x === 'note')).toHaveLength(2);
  });
});
