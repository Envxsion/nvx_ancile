/**
 * Run safety: every status write is a compare-and-set, so a cancel, the
 * sweeper and a worker never overwrite each other; an answer that arrives
 * before the pause is saved is not lost; a step a crash left unfinished is
 * not run again; one thread has one live run; a run the sweeper gives up on
 * is finalised like any failure.
 */
import { describe, expect, it } from 'vitest';
import {
  type RunHandler,
  RunOwnershipLost,
  type RunRecord,
  StepUncertain,
  sweep,
} from '../../src/runs/engine';
import { MemoryRunEventLog, replayThenTail } from '../../src/runs/events';
import { MemoryRunStore } from '../../src/runs/store';
import { RunWorker } from '../../src/runs/worker';

const until = async (check: () => Promise<boolean> | boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const newRun = (id: string, threadId: string | null = null, checkpoint: unknown = {}) => ({
  id,
  kind: 'agent' as const,
  traceId: 't'.repeat(32),
  threadId,
  messageId: null,
  checkpoint,
});

function setup(handler: RunHandler, extra: Partial<ConstructorParameters<typeof RunWorker>[0]> = {}) {
  const store = new MemoryRunStore();
  const events = new MemoryRunEventLog();
  const worker = new RunWorker({
    store,
    events,
    handlers: { agent: handler },
    pollMs: 10,
    sweepMs: 60_000,
    leaseMs: 1_000,
    ...extra,
  });
  return { store, events, worker };
}

describe('compare-and-set saves', () => {
  it('writes nothing when the run moved since it was read', async () => {
    const store = new MemoryRunStore();
    const run = await store.create(newRun('run_1'));
    expect(await store.save({ ...run, status: 'cancelled' }, { status: 'queued' })).toBe(true);
    // A writer that still thinks the run is queued loses.
    expect(await store.save({ ...run, status: 'failed' }, { status: 'queued' })).toBe(false);
    expect((await store.get('run_1'))?.status).toBe('cancelled');
  });

  it('checks the lease owner while running', async () => {
    const store = new MemoryRunStore();
    await store.create(newRun('run_2'));
    const claimed = (await store.claim('worker-a', 1_000)) as RunRecord;
    expect(await store.save({ ...claimed, checkpoint: 1 }, { status: 'running', owner: 'worker-b' })).toBe(
      false,
    );
    expect(await store.save({ ...claimed, checkpoint: 2 }, { status: 'running', owner: 'worker-a' })).toBe(
      true,
    );
  });

  it('does not let the sweeper take back a run whose lease was renewed', async () => {
    const store = new MemoryRunStore();
    await store.create(newRun('run_3'));
    await store.claim('worker-a', 10);
    const later = new Date(Date.now() + 1_000);
    // The worker renews between the sweeper's read and its write.
    const original = store.expiredLeases.bind(store);
    store.expiredLeases = async (now) => {
      const stale = await original(now);
      await store.renew('run_3', 'worker-a', 60_000);
      return stale;
    };
    expect((await sweep(store, later)).requeued).toEqual([]);
    expect((await store.get('run_3'))?.status).toBe('running');
  });

  it('allows one live run per thread', async () => {
    const store = new MemoryRunStore();
    await store.create(newRun('run_4', 'thr_1'));
    await expect(store.create(newRun('run_5', 'thr_1'))).rejects.toMatchObject({
      code: 'run.already_running',
      status: 409,
    });
    // Once the first ends, the thread is free again.
    const first = (await store.get('run_4')) as RunRecord;
    await store.save({ ...first, status: 'cancelled' }, { status: 'queued' });
    await expect(store.create(newRun('run_5', 'thr_1'))).resolves.toMatchObject({ status: 'queued' });
  });
});

describe('the worker under races', () => {
  it('stops a handler whose run was cancelled elsewhere instead of overwriting the cancel', async () => {
    let lost: unknown = null;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { store, worker } = setup({
      async execute(ctx) {
        await gate;
        try {
          await ctx.checkpoint({ step: 2 });
        } catch (err) {
          lost = err;
          throw err;
        }
        return { kind: 'done' };
      },
    });
    await store.create(newRun('run_c'));
    await worker.start();
    await until(async () => (await store.get('run_c'))?.status === 'running');
    // Another Core cancels it (a compare-and-set on the lease it saw).
    const seen = (await store.get('run_c')) as RunRecord;
    await store.save({ ...seen, status: 'cancelled' }, { status: 'running', owner: seen.leaseOwner ?? null });
    release();
    await until(() => lost !== null);
    await worker.drain();
    expect(lost).toBeInstanceOf(RunOwnershipLost);
    expect((await store.get('run_c'))?.status).toBe('cancelled');
    worker.stop();
  });

  it('requeues a run whose approval was answered before its pause was saved', async () => {
    const seen: unknown[] = [];
    let worker: RunWorker | undefined;
    const handler: RunHandler = {
      async execute(ctx) {
        seen.push(ctx.run.checkpoint);
        if ((ctx.run.checkpoint as { step: number }).step === 0) {
          // The person answers while this run is still running.
          expect(await worker?.resume(ctx.run.id)).toBe(true);
          return { kind: 'pause', reason: 'approval', checkpoint: { step: 1 } };
        }
        return { kind: 'done' };
      },
    };
    const s = setup(handler);
    worker = s.worker;
    await s.store.create(newRun('run_r', null, { step: 0 }));
    await worker.start();
    await until(async () => (await s.store.get('run_r'))?.status === 'succeeded');
    expect(seen).toEqual([{ step: 0 }, { step: 1 }]);
    worker.stop();
  });

  it('cancels a run that was asking for approval when Stop arrived, and lets it tidy up', async () => {
    let tidied = false;
    let worker: RunWorker | undefined;
    const handler: RunHandler = {
      async execute(ctx) {
        await worker?.cancel(ctx.run.id);
        return { kind: 'pause', reason: 'approval', checkpoint: {} };
      },
      cancelled: async () => {
        tidied = true;
      },
    };
    const s = setup(handler);
    worker = s.worker;
    await s.store.create(newRun('run_s'));
    await worker.start();
    await until(async () => (await s.store.get('run_s'))?.status === 'cancelled');
    expect(tidied).toBe(true);
    worker.stop();
  });

  it('does not repeat a side effect a crash left unfinished; a read may run again', async () => {
    const effects: string[] = [];
    let thrown: unknown = null;
    const { store, worker } = setup({
      async execute(ctx) {
        await ctx.once(1, 'tool_call', {}, async () => effects.push('read'), { rerunnable: true });
        try {
          await ctx.once(2, 'tool_call', {}, async () => effects.push('write'));
        } catch (err) {
          thrown = err;
        }
        return { kind: 'done' };
      },
    });
    await store.create(newRun('run_u'));
    // A previous worker died in the middle of both steps.
    for (const seq of [1, 2])
      await store.putStep({
        runId: 'run_u',
        seq,
        kind: 'tool_call',
        idempotencyKey: `run_u:${seq}`,
        status: 'in_progress',
        input: {},
        output: null,
      });
    await worker.start();
    await until(async () => (await store.get('run_u'))?.status === 'succeeded');
    expect(effects).toEqual(['read']);
    expect(thrown).toBeInstanceOf(StepUncertain);
    expect(thrown).toMatchObject({ code: 'run.step_uncertain' });
    expect((await store.step('run_u', 2))?.status).toBe('uncertain');
    worker.stop();
  });

  it('finalises a run the sweeper gives up on: handler, error and done', async () => {
    const failed: string[] = [];
    const settled: string[] = [];
    const { store, events, worker } = setup(
      {
        execute: async () => ({ kind: 'done' }),
        failed: async (run, error) => {
          failed.push(`${run.id}:${error.code}`);
        },
      },
      {
        onSettled: async (run) => {
          settled.push(run.id);
        },
      },
    );
    const run = await store.create(newRun('run_g'));
    await store.claim('dead-worker', 1);
    await store.save({ ...run, status: 'running', attempt: 4 }, { status: 'running' });
    await new Promise((r) => setTimeout(r, 5));
    await worker.start();
    expect((await store.get('run_g'))?.status).toBe('failed');
    expect(failed).toEqual(['run_g:run.crashed']);
    expect(settled).toEqual(['run_g']);
    const types = (await events.since('run_g', 0)).map((e) => e.type);
    expect(types).toEqual(['run.status', 'error', 'done']);
    worker.stop();
  });
});

describe('replay then tail', () => {
  it('unsubscribes when reading history fails', async () => {
    const log = new MemoryRunEventLog();
    let subscribed = 0;
    const original = log.subscribe.bind(log);
    log.subscribe = (id, fn) => {
      subscribed++;
      const off = original(id, fn);
      return () => {
        subscribed--;
        off();
      };
    };
    log.since = async () => {
      throw new Error('database gone');
    };
    await expect(replayThenTail(log, 'run_x', 0, () => undefined)).rejects.toThrow('database gone');
    expect(subscribed).toBe(0);
  });
});
