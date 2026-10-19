/**
 * LB1: the same tool call failing the same way, again and again, ends the
 * turn out loud. Three identical failures in a row stop it; different
 * arguments, a success or a person's "no" start the count again.
 */
import type { Message, Part, ThreadPath } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  callSignature,
  LOOP_LIMIT,
  type LoopState,
  noteResult,
  POLL_LIMIT,
} from '../../src/conductor/loopguard';
import { type Harness, harness } from '../support/harness';

const fail = { ok: false, text: 'ENOENT: no such file' };
const call = (args: unknown, polls = false) => ({ tool: 'fs_read', args, polls });

function run(args: unknown[], outcomes: boolean[], polls = false) {
  let state: LoopState | undefined;
  let stop = null as ReturnType<typeof noteResult>['stop'];
  args.forEach((a, i) => {
    const r = noteResult(state, call(a, polls), outcomes[i] ? { ok: true, text: 'fine' } : fail);
    state = r.state;
    stop = stop ?? r.stop;
  });
  return stop;
}

describe('noteResult', () => {
  it('stops the third identical failing call, with a line for the model and one for the user', () => {
    const a = { path: 'a.md' };
    expect(run([a, a], [false, false])).toBeNull();
    const stop = run([a, a, a], [false, false, false]);
    expect(stop?.count).toBe(LOOP_LIMIT);
    expect(stop?.forModel).toMatch(/failed 3 times in a row/);
    expect(stop?.forUser).toMatch(/^I stopped because the same fs_read call failed 3 times/);
    expect(stop?.forUser).toContain('ENOENT');
  });

  it('calls with different arguments are not one loop', () => {
    expect(
      run([{ path: 'a' }, { path: 'b' }, { path: 'c' }, { path: 'a' }], [false, false, false, false]),
    ).toBeNull();
  });

  it('a success starts the count again', () => {
    const a = { path: 'a.md' };
    expect(run([a, a, a, a, a], [false, false, true, false, false])).toBeNull();
  });

  it('a person declining is not a failure of the call', () => {
    const a = { path: 'a.md' };
    let state: LoopState | undefined;
    for (let i = 0; i < 5; i++)
      state = noteResult(state, call(a), { ok: false, text: 'declined', declinedByUser: true }).state;
    expect(state).toBeUndefined();
  });

  it('near-identical arguments count as the same: key order, spacing and case', () => {
    const a = callSignature('t', { path: 'Notes/A.md', mode: 'r' });
    expect(callSignature('t', { mode: 'r', path: '  notes/a.md ' })).toBe(a);
    expect(callSignature('t', { path: 'notes/b.md', mode: 'r' })).not.toBe(a);
    expect(callSignature('u', { path: 'Notes/A.md', mode: 'r' })).not.toBe(a);
    expect(
      run([{ path: 'Notes/A.md' }, { path: 'notes/a.md ' }, { path: 'NOTES/A.MD' }], [false, false, false]),
    ).not.toBeNull();
  });

  it('a polled tool gets more attempts before it is stopped', () => {
    const a = { job: 1 };
    expect(run(Array(POLL_LIMIT - 1).fill(a), Array(POLL_LIMIT - 1).fill(false), true)).toBeNull();
    expect(run(Array(POLL_LIMIT).fill(a), Array(POLL_LIMIT).fill(false), true)).not.toBeNull();
  });
});

describe('in a turn', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('a model that repeats a failing call is stopped after three, and the user is told', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, '/loop fs_read {"path":"missing.md"}');
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
    const path = (await h.call<ThreadPath>('GET', `/threads/${t}/path`)).body;
    const parts = (path.messages.at(-1) as Message).parts;
    const results = parts.filter(
      (p): p is Extract<Part, { type: 'tool_result' }> => p.type === 'tool_result',
    );
    expect(results).toHaveLength(LOOP_LIMIT);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(String(results.at(-1)?.result)).toMatch(/Do not make it again/);
    const text = parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('');
    expect(text).toMatch(/I stopped because the same fs_read call failed 3 times in a row/);
  });
});
