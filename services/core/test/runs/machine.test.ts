import type { RunEvent } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { MemoryRunEventLog, replayThenTail } from '../../src/runs/events';
import { canTransition, IllegalTransition, transition } from '../../src/runs/machine';

describe('run state machine', () => {
  it('walks a run that pauses for approval and resumes', () => {
    let s = { status: 'queued' as const, attempt: 0 } as Parameters<typeof transition>[0];
    for (const e of ['start', 'need_approval', 'resume', 'start', 'complete'] as const) s = transition(s, e);
    expect(s).toEqual({ status: 'succeeded', attempt: 0 });
  });

  it('pauses for a waking node and can be cancelled while waiting', () => {
    let s = transition({ status: 'running', attempt: 0 }, 'need_compute');
    expect(s.status).toBe('waiting_compute');
    s = transition(s, 'cancel');
    expect(s.status).toBe('cancelled');
  });

  it('requeues on an expired lease and gives up after max attempts', () => {
    expect(transition({ status: 'running', attempt: 0 }, 'lease_expired')).toEqual({
      status: 'queued',
      attempt: 1,
    });
    expect(transition({ status: 'running', attempt: 4 }, 'lease_expired', { maxAttempts: 5 })).toEqual({
      status: 'failed',
      attempt: 5,
    });
  });

  it('refuses illegal moves loudly', () => {
    expect(() => transition({ status: 'succeeded', attempt: 0 }, 'start')).toThrow(IllegalTransition);
    expect(() => transition({ status: 'queued', attempt: 0 }, 'complete')).toThrow(/cannot complete/);
    expect(canTransition('cancelled', 'cancel')).toBe(false);
  });
});

describe('run event log', () => {
  it('replays from Last-Event-ID then tails live with no gap or duplicate', async () => {
    const log = new MemoryRunEventLog();
    const delta = (d: string) => ({ type: 'text.delta' as const, message_id: 'msg_1', delta: d });
    await log.append('run_1', delta('a'));
    await log.append('run_1', delta('b'));
    await log.append('run_1', delta('c'));

    const seen: RunEvent[] = [];
    const stop = await replayThenTail(log, 'run_1', 1, (e) => seen.push(e));
    await log.append('run_1', delta('d'));
    stop();
    await log.append('run_1', delta('e'));

    expect(seen.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(seen.map((e) => (e.type === 'text.delta' ? e.delta : ''))).toEqual(['b', 'c', 'd']);
  });
});
