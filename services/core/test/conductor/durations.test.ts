/**
 * Each tool result records how long its step took, from the call to the
 * result: through a pause for approval and a restart too. A re-run, which
 * answers from the record without running anything, records none.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message, Part, RunEvent, ThreadPath } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { stepDuration } from '../../src/conductor/pipeline';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

type ToolResult = Extract<Part, { type: 'tool_result' }>;

const of = <T extends RunEvent['type']>(evs: RunEvent[], type: T) =>
  evs.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);

async function lastResult(threadId: string): Promise<ToolResult | undefined> {
  const path = (await h.call<ThreadPath>('GET', `/threads/${threadId}/path`)).body;
  const m = path.messages.at(-1) as Message;
  return m.parts.find((p): p is ToolResult => p.type === 'tool_result');
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('stepDuration', () => {
  it('is whole milliseconds from the call', () => {
    expect(stepDuration(1_000, 3_400.6)).toBe(2_401);
    expect(stepDuration(5, 5)).toBe(0);
  });

  it('is never negative when the clock stepped back', () => {
    expect(stepDuration(10_000, 9_000)).toBe(0);
  });

  it('is absent when the start was never recorded', () => {
    expect(stepDuration(undefined, 1_000)).toBeUndefined();
    expect(stepDuration('12', 1_000)).toBeUndefined();
    expect(stepDuration(Number.NaN, 1_000)).toBeUndefined();
    expect(stepDuration(1_000, Number.NaN)).toBeUndefined();
  });
});

describe('tool results carry their duration', () => {
  it('a tool that runs at once', async () => {
    h = await harness();
    await writeFile(join(h.dir, 'notes.md'), 'hello file');
    const t = await h.newThread();
    const before = Date.now();
    const sent = await h.send(t, '/tool fs_read {"path":"notes.md"}');
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
    const took = Date.now() - before;
    const r = await lastResult(t);
    expect(r?.ok).toBe(true);
    expect(Number.isInteger(r?.duration_ms)).toBe(true);
    expect(r?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(r?.duration_ms).toBeLessThanOrEqual(took);
  });

  it('a step that failed, and one for a tool that does not exist', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_read {"path":"/workspace/../etc/passwd"}');
    await h.settle(sent.run_id);
    expect(await lastResult(t)).toMatchObject({ ok: false, duration_ms: expect.any(Number) });

    const other = await h.send(t, '/tool no_such_tool {}', {
      parent_id: (await h.call<ThreadPath>('GET', `/threads/${t}/path`)).body.messages.at(-1)?.id,
    });
    await h.settle(other.run_id);
    expect(await lastResult(t)).toMatchObject({ ok: false, duration_ms: expect.any(Number) });
  });

  it('from the call, so the time it waited for you counts, across a restart', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_write {"path":"r.md","content":"after restart"}');
    expect((await h.settle(sent.run_id)).status).toBe('waiting_approval');
    await wait(60);
    await h.restart();
    const pending = (await h.call<{ items: { id: string }[] }>('GET', '/approvals')).body.items;
    await h.call('POST', `/approvals/${pending[0]?.id}`, { decision: 'approve', scope: 'once' });
    expect((await h.settle(sent.run_id)).status).toBe('succeeded');
    const r = await lastResult(t);
    expect(r?.ok).toBe(true);
    expect(r?.duration_ms).toBeGreaterThanOrEqual(60);
  });

  it('a declined step too', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_write {"path":"x.md","content":"x"}');
    await h.settle(sent.run_id);
    const ask = of(await h.eventsOf(sent.run_id), 'approval.required')[0];
    await h.call('POST', `/approvals/${ask?.approval_id}`, { decision: 'deny', scope: 'once', reason: 'no' });
    await h.settle(sent.run_id);
    expect(await lastResult(t)).toMatchObject({ declined_reason: 'no', duration_ms: expect.any(Number) });
  });

  it('a re-run answers from the record and records no duration of its own', async () => {
    h = await harness({ ops: true });
    const t = await h.newThread();
    const sent = await h.send(t, '/tool fs_list {"path":"/workspace"}');
    await h.settle(sent.run_id);
    expect((await lastResult(t))?.duration_ms).toEqual(expect.any(Number));
    const rerun = await h.call<{ run_id: string }>('POST', `/runs/${sent.run_id}/rerun`, { from_step: 0 });
    await h.settle(rerun.body.run_id);
    const again = await lastResult(t);
    expect(again).toMatchObject({ ok: true });
    expect(again).not.toHaveProperty('duration_ms');
  });
});
