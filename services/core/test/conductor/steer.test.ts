/**
 * ------------------------------------------------------------------
 *  Title    |  Steering a running answer (CH7)
 *  Ref      |  ROADMAP.md CH7 · conductor/steer.ts
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  A note offered while a model works reaches it at the
 *           |  next step boundary, as a user note the model sees, is
 *           |  recorded on the answer, and is refused or expires
 *           |  where it cannot go in.
 * ------------------------------------------------------------------
 */

import type { Message } from '@nvx/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spliceNotes } from '../../src/conductor/context';
import { noteMessage, STEER_LIMITS, SteerBus } from '../../src/conductor/steer';
import { type Harness, harness } from '../support/harness';

vi.setConfig({ testTimeout: 15_000 });

describe('the step-boundary bus', () => {
  const T = 'thr_1';
  const M = 'msg_1';

  it('takes a note at the next boundary and says which round it went into', () => {
    const bus = new SteerBus();
    bus.begin(T, M, { steerable: true });
    const n = bus.offer(T, '  use the Q3 file  ');
    expect(n).toMatchObject({ text: 'use the Q3 file', state: 'pending' });
    expect(bus.take(T, M, 2)).toHaveLength(1);
    expect(bus.get(n.id)).toMatchObject({ state: 'applied', round: 2 });
    // Taken once: the next boundary finds nothing new.
    expect(bus.take(T, M, 3)).toHaveLength(0);
  });

  it('expires a note the turn ended before it could take (the Cockpit then sends it as a message)', () => {
    const bus = new SteerBus();
    bus.begin(T, M, { steerable: true });
    const n = bus.offer(T, 'too late');
    bus.end(T, M);
    expect(bus.get(n.id)?.state).toBe('expired');
    expect(() => bus.offer(T, 'again')).toThrow(expect.objectContaining({ code: 'steer.not_running' }));
  });

  it('refuses where there is nothing to steer: no turn, a flow, an engine that runs its own loop', () => {
    const bus = new SteerBus();
    expect(bus.capability(T)).toEqual({ steerable: false, why: 'no_turn' });
    bus.begin(T, M, { steerable: false });
    expect(bus.capability(T)).toMatchObject({ steerable: false, why: 'flow' });
    expect(() => bus.offer(T, 'hi')).toThrow(expect.objectContaining({ code: 'steer.not_supported' }));
    bus.begin(T, M, { steerable: false, why: 'engine' });
    expect(bus.capability(T)).toMatchObject({ why: 'engine' });
  });

  it('refuses a note written under another answer (the person moved branches)', () => {
    const bus = new SteerBus();
    bus.begin(T, M, { steerable: true });
    expect(() => bus.offer(T, 'hi', 'msg_other')).toThrow(
      expect.objectContaining({ code: 'steer.branch_changed' }),
    );
    // A reply Core has not named yet is the one being written.
    expect(bus.offer(T, 'hi', 'pending-1').state).toBe('pending');
    expect(bus.offer(T, 'hi', M).state).toBe('pending');
  });

  it('limits how many wait and how long one is, and lets a waiting note be taken back', () => {
    const bus = new SteerBus();
    bus.begin(T, M, { steerable: true });
    const notes = Array.from({ length: STEER_LIMITS.pending }, (_, i) => bus.offer(T, `note ${i}`));
    expect(() => bus.offer(T, 'one more')).toThrow(expect.objectContaining({ code: 'steer.too_many' }));
    expect(bus.cancel(notes[0]?.id ?? '')).toBe(true);
    expect(bus.offer(T, 'now there is room').state).toBe('pending');
    expect(() => bus.offer(T, 'x'.repeat(STEER_LIMITS.chars + 1))).toThrow(
      expect.objectContaining({ code: 'steer.too_long' }),
    );
    bus.take(T, M, 1);
    expect(bus.cancel(notes[1]?.id ?? '')).toBe(false);
  });

  it('forgets a turn nobody ended after six hours', () => {
    let now = 0;
    const bus = new SteerBus(() => now);
    bus.begin(T, M, { steerable: true });
    const n = bus.offer(T, 'hi');
    now = STEER_LIMITS.staleMs + 1;
    expect(bus.capability(T).why).toBe('no_turn');
    expect(bus.get(n.id)?.state).toBe('expired');
  });

  it('frames the person’s words as a note, quoted, for the model', () => {
    expect(noteMessage('stop using the web')).toContain('<user_note>\nstop using the web\n</user_note>');
    const call = { type: 'tool_call' as const, call_id: 'c1', tool: 't', args: {} };
    const result = { type: 'tool_result' as const, call_id: 'c1', ok: true, result: 1 };
    expect(spliceNotes([call, result], [{ id: 'a', text: 'x', round: 1, part: 2, at: '' }])).toEqual([
      expect.objectContaining({ role: 'assistant' }),
      { role: 'user', content: noteMessage('x') },
    ]);
    expect(spliceNotes([], undefined)).toEqual([]);
  });
});

describe('in a turn', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('a note offered at a step boundary is in the next request, stays in the ones after, and is on the answer', async () => {
    const steer = new SteerBus();
    // Offer the note as the model reaches its second round: the same moment a person's note would land.
    const take = steer.take.bind(steer);
    let offered = false;
    steer.take = (thread, message, round) => {
      if (round === 1 && !offered) {
        offered = true;
        steer.offer(thread, 'Please use the Q3 file instead');
      }
      return take(thread, message, round);
    };
    h = await harness({ steer });
    const t = await h.newThread();
    const sent = await h.send(t, '/loop fs_read {"path":"missing.md"}');
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');

    const requests = h.provider.calls.map((c) => c.req);
    const noted = (r: (typeof requests)[number]) =>
      r.messages.some(
        (m) => m.role === 'user' && m.content.includes('<user_note>\nPlease use the Q3 file instead'),
      );
    expect(noted(requests[0] as never)).toBe(false);
    expect(noted(requests[1] as never)).toBe(true);
    // The note is the last thing in the request: the cached start of the prompt is untouched.
    expect(requests[1]?.messages.at(-1)?.content).toContain('Please use the Q3 file instead');

    const answer = (await h.repo.getMessage(sent.assistant_message_id)) as Message;
    expect(answer.provenance.steered).toEqual([
      expect.objectContaining({ text: 'Please use the Q3 file instead', round: 1 }),
    ]);
    // The turn is over: no note can go in now.
    expect(steer.capability(t)).toEqual({ steerable: false, why: 'no_turn' });
  });

  it('without a bus nothing changes: no note, no provenance', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, '/say hello');
    await h.settle(sent.run_id);
    const answer = (await h.repo.getMessage(sent.assistant_message_id)) as Message;
    expect(answer.provenance.steered).toBeUndefined();
  });
});
