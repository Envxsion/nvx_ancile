/**
 * Phase 5 replay: a run can be stepped through, and re-run from a step with
 * another model without any tool running a second time.
 */
import type { Message, Part, RunEvent, RunReplay, ThreadPath } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { prefixFor, recordedCalls, replayedResult, stepsFrom } from '../../src/obs/replay';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

const ev = (seq: number, e: Record<string, unknown>) =>
  ({ seq, at: `2026-10-08T00:00:0${seq}Z`, ...e }) as RunEvent;

describe('steps', () => {
  const events: RunEvent[] = [
    ev(1, { type: 'model', message_id: 'm', model_id: 'a/x', display_name: 'X' }),
    ev(2, { type: 'text.delta', message_id: 'm', delta: 'Let me ' }),
    ev(3, { type: 'text.delta', message_id: 'm', delta: 'look.' }),
    ev(4, { type: 'tool.call', call_id: 'c1', tool: 'fs_list', args_preview: { path: '/' }, tier: 'auto' }),
    ev(5, { type: 'tool.result', call_id: 'c1', ok: true, preview: 'a.md' }),
    ev(6, { type: 'text.delta', message_id: 'm', delta: 'Found a.md.' }),
    ev(7, { type: 'run.status', status: 'succeeded' }),
  ];

  it('folds streamed text into one step and pairs a tool call with its result', () => {
    const steps = stepsFrom(events);
    expect(steps.map((s) => s.kind)).toEqual(['model', 'text', 'tool', 'text', 'status']);
    expect(steps[1]?.detail).toBe('Let me look.');
    expect(steps[2]?.tool).toMatchObject({ name: 'fs_list', ok: true, result: 'a.md' });
    expect(steps.filter((s) => s.rerunnable).map((s) => s.n)).toEqual([0, 2]);
  });

  it('keeps the answer up to the chosen tool call', () => {
    const parts: Part[] = [
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_call', call_id: 'c1', tool: 'fs_list', args: { path: '/' } },
      { type: 'tool_result', call_id: 'c1', ok: true, result: 'a.md' },
      { type: 'text', text: 'Found a.md.' },
    ];
    const steps = stepsFrom(events);
    expect(prefixFor(parts, steps, 0)).toEqual([]);
    expect(prefixFor(parts, steps, 2)).toEqual([parts[0]]);
    // From after the last tool call: every finished tool round is kept.
    expect(prefixFor(parts, steps, 3)).toEqual(parts.slice(0, 3));
  });

  it('answers a tool from the record, once each, and never runs one', () => {
    const calls = recordedCalls([
      { type: 'tool_call', call_id: 'c1', tool: 'fs_list', args: { path: '/', depth: 1 } },
      { type: 'tool_result', call_id: 'c1', ok: true, result: 'a.md' },
    ]);
    const replay = { fromRunId: 'run_x', fromStep: 0, calls };
    const hit = replayedResult(replay, [], { tool: 'fs_list', args: { depth: 1, path: '/' } });
    expect(hit).toMatchObject({ ok: true, result: 'a.md', index: 0 });
    const again = replayedResult(replay, [0], { tool: 'fs_list', args: { depth: 1, path: '/' } });
    expect(again.ok).toBe(false);
    expect(String(again.result)).toContain('Not run');
  });
});

describe('re-run from a step', () => {
  async function answer(t: string): Promise<Message> {
    const path = (await h.call<ThreadPath>('GET', `/threads/${t}/path`)).body;
    return path.messages.at(-1) as Message;
  }

  it('replays a finished run and re-runs it with no tool side effects', async () => {
    h = await harness({ ops: true });
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_list {"path":"/workspace"}');
    await h.settle(sent.run_id);
    const original = await answer(t);
    const originalResult = original.parts.find((p) => p.type === 'tool_result');
    expect(originalResult).toBeTruthy();

    const replay = (await h.call<RunReplay>('GET', `/runs/${sent.run_id}/replay`)).body;
    expect(replay.steps.some((s) => s.kind === 'tool')).toBe(true);

    const rerun = await h.call<{ run_id: string; assistant_message_id: string }>(
      'POST',
      `/runs/${sent.run_id}/rerun`,
      {
        from_step: 0,
        model: 'offline/echo',
      },
    );
    expect(rerun.status).toBe(202);
    await h.settle(rerun.body.run_id);
    // No tool call was recorded as a side effect in the new run.
    for (let seq = 1; seq < 10; seq++)
      expect((await h.runs.step(rerun.body.run_id, seq))?.kind).not.toBe('tool_call');
    const m = await answer(t);
    expect(m.id).toBe(rerun.body.assistant_message_id);
    expect(m.parent_id).toBe(original.parent_id);
    expect((m.provenance as { rerun_of?: { run_id: string } }).rerun_of?.run_id).toBe(sent.run_id);
  });

  it('answers the re-run model’s tool call from the original record', async () => {
    h = await harness({ ops: true });
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_list {"path":"/workspace"}');
    await h.settle(sent.run_id);
    const original = (await answer(t)).parts.find((p) => p.type === 'tool_result');
    const rerun = await h.call<{ run_id: string }>('POST', `/runs/${sent.run_id}/rerun`, { from_step: 0 });
    await h.settle(rerun.body.run_id);
    const again = (await answer(t)).parts.find((p) => p.type === 'tool_result');
    expect(again).toMatchObject({ ok: true });
    expect((again as { result: unknown }).result).toEqual((original as { result: unknown }).result);
  });

  it('refuses a step that does not exist', async () => {
    h = await harness({ ops: true });
    const t = await h.newThread();
    const sent = await h.send(t, '/say hello');
    await h.settle(sent.run_id);
    const r = await h.call('POST', `/runs/${sent.run_id}/rerun`, { from_step: 99 });
    expect(r.status).toBe(422);
  });
});
