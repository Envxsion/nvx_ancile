/**
 * KP1 (Pro): what runs when one of your own palette commands is chosen. A chain is checked whole
 * before its first step, stops at the first step that fails and names it, and only an action that
 * can be undone may end it. A flow needs its input and its flow to still exist.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  type ChainAction,
  chainProblem,
  chainSaid,
  commandInScope,
  describeCommand,
  FLOW_INPUT_MAX,
  FLOW_PROBLEM_WORDS,
  flowInput,
  runChain,
  threadTranscript,
} from '../src/palette/userCommands';
import type { UserCommandView } from '../src/pro/slot';

const act = (id: string, over: Partial<ChainAction> = {}): ChainAction => ({
  id,
  label: `Do ${id}`,
  run: vi.fn(),
  ...over,
});
const finder =
  (...all: ChainAction[]) =>
  (id: string) =>
    all.find((a) => a.id === id);

describe('a chain of palette actions', () => {
  it('runs every step in order, waiting for each', async () => {
    const order: string[] = [];
    const slow = act('a', {
      run: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('a');
      },
    });
    const quick = act('b', { run: () => void order.push('b') });
    expect(await runChain(['a', 'b'], finder(slow, quick))).toEqual({ ok: true, done: 2 });
    expect(order).toEqual(['a', 'b']);
  });

  it('stops at the step that fails and says which, and what already ran', async () => {
    const third = act('c');
    const r = await runChain(
      ['a', 'b', 'c'],
      finder(
        act('a'),
        act('b', {
          run: () => {
            throw new Error('Core did not answer');
          },
        }),
        third,
      ),
    );
    expect(r).toMatchObject({ ok: false, done: 1, step: 2, label: 'Do b' });
    expect(third.run).not.toHaveBeenCalled();
    const said = chainSaid('Tidy up', r, 3);
    expect(said.title).toBe('Tidy up stopped at step 2');
    expect(said.body).toContain('Step 2, "Do b" failed: Core did not answer');
    expect(said.body).toContain('1 step ran before it');
  });

  it('runs nothing when a step is gone or does not apply here', async () => {
    const a = act('a');
    expect(await runChain(['a', 'gone'], finder(a))).toMatchObject({
      ok: false,
      done: 0,
      step: 2,
      label: 'gone',
    });
    const off = act('off', { unavailable: 'it does not apply to what is open' });
    const r = await runChain(['a', 'off'], finder(a, off));
    expect(r).toMatchObject({ ok: false, done: 0, step: 2 });
    expect(chainSaid('X', r, 2).body).toContain('is not available here');
    expect(a.run).not.toHaveBeenCalled();
  });

  it('lets an action that takes something away end the chain, and nothing else', async () => {
    const del = act('delete', { destructive: true });
    const pin = act('pin');
    expect(chainProblem(['pin', 'delete'], finder(pin, del))).toBeNull();
    expect(chainProblem(['delete', 'pin'], finder(pin, del))).toMatchObject({ step: 1, label: 'Do delete' });
    expect(await runChain(['delete', 'pin'], finder(pin, del))).toMatchObject({ ok: false, done: 0 });
    expect(del.run).not.toHaveBeenCalled();
  });

  it('says plainly that a whole chain ran', () => {
    expect(chainSaid('Tidy up', { ok: true, done: 1 }, 1)).toEqual({
      title: 'Tidy up done',
      body: '1 of 1 step ran.',
    });
  });
});

describe('where a command is offered', () => {
  it('shows a notebook command only inside that notebook, and an unscoped one everywhere', () => {
    expect(commandInScope({ notebook_id: null }, 'nb1')).toBe(true);
    expect(commandInScope({ notebook_id: 'nb1' }, 'nb1')).toBe(true);
    expect(commandInScope({ notebook_id: 'nb1' }, 'nb2')).toBe(false);
    expect(commandInScope({ notebook_id: 'nb1' }, null)).toBe(false);
    expect(commandInScope({ notebook_id: 'nb1' }, undefined)).toBe(false);
  });
});

describe('a flow command', () => {
  it('needs selected text for the selection, and a thread for the thread', () => {
    expect(flowInput({ flow_target: 'selection' }, { selection: '  ', thread: 'x' })).toEqual({
      problem: 'no_selection',
    });
    expect(flowInput({ flow_target: 'selection' }, { selection: ' a pump ', thread: null })).toEqual({
      text: 'a pump',
    });
    expect(flowInput({ flow_target: 'thread' }, { selection: 'a', thread: null })).toEqual({
      problem: 'no_thread',
    });
    expect(flowInput({ flow_target: 'thread' }, { selection: '', thread: '' })).toEqual({ problem: 'empty' });
  });

  it('cuts very long input and marks the cut', () => {
    const r = flowInput(
      { flow_target: 'selection' },
      { selection: 'x'.repeat(FLOW_INPUT_MAX + 50), thread: null },
    );
    expect('text' in r && r.text.endsWith(' …') && r.text.length).toBe(FLOW_INPUT_MAX + 2);
  });

  it('says a missing flow in its own words, with what to do', () => {
    const w = FLOW_PROBLEM_WORDS.flow_missing('Summarise', 'Digest');
    expect(w.title).toBe('Summarise cannot run: its flow is gone');
    expect(w.body).toContain('"Digest" was deleted');
    expect(w.body).toContain('Edit the command');
    expect(FLOW_PROBLEM_WORDS.flow_missing('X', '').body).toContain('The flow was deleted');
  });

  it('turns a thread into who-said-what text, skipping empty messages', () => {
    expect(
      threadTranscript('Pumps', [
        { role: 'user', text: 'Which pump?' },
        { role: 'assistant', text: '  ' },
        { role: 'assistant', text: 'The A1.' },
      ]),
    ).toBe('Pumps\n\nYou: Which pump?\n\nAssistant: The A1.');
    expect(threadTranscript('Empty', [])).toBe('');
  });
});

describe('how a command reads in the palette', () => {
  const label = (id: string) => ({ pin: 'Pin this thread', export: 'Export this thread' })[id];
  it('lists a chain’s steps by their palette names', () => {
    const c: UserCommandView = {
      id: 'c',
      name: 'T',
      notebook_id: null,
      kind: 'chain',
      steps: ['pin', 'export'],
      flow_id: null,
      flow_target: null,
    };
    expect(describeCommand(c, label, () => undefined)).toBe(
      '2 steps: Pin this thread, then Export this thread',
    );
  });
  it('says what a flow command runs on, and when its flow is gone', () => {
    const c: UserCommandView = {
      id: 'c',
      name: 'T',
      notebook_id: null,
      kind: 'flow',
      steps: [],
      flow_id: 'f1',
      flow_target: 'selection',
    };
    expect(describeCommand(c, label, () => 'Digest')).toBe('Runs Digest on the selection');
    expect(describeCommand(c, label, () => null)).toBe('Flow missing, was run on the selection');
  });
});
