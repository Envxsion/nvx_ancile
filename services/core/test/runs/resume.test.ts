/**
 * Durable runs: a worker that dies mid-run loses nothing, a recorded side
 * effect never runs twice, and a cancel lands wherever the run is.
 */
import { describe, expect, it } from 'vitest';
import type { RunHandler } from '../../src/runs/engine';
import { MemoryRunEventLog } from '../../src/runs/events';
import { MemoryRunStore } from '../../src/runs/store';
import { RunWorker } from '../../src/runs/worker';

const until = async (check: () => Promise<boolean>, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

function setup(handler: RunHandler) {
  const store = new MemoryRunStore();
  const events = new MemoryRunEventLog();
  const worker = new RunWorker({
    store,
    events,
    handlers: { agent: handler },
    pollMs: 10,
    sweepMs: 60_000,
    leaseMs: 1_000,
  });
  return { store, events, worker };
}

describe('the run worker', () => {
  it('runs a queued run to success and closes its stream', async () => {
    const { store, events, worker } = setup({ execute: async () => ({ kind: 'done' }) });
    await store.create({
      id: 'run_a',
      kind: 'agent',
      traceId: 't'.repeat(32),
      threadId: null,
      messageId: null,
      checkpoint: {},
    });
    await worker.start();
    await until(async () => (await store.get('run_a'))?.status === 'succeeded');
    const types = (await events.since('run_a', 0)).map((e) => e.type);
    expect(types).toEqual(['run.status', 'run.status', 'done']);
    worker.stop();
  });

  it('reclaims a run whose worker died, and the recorded step is not executed again', async () => {
    let effects = 0;
    let crash = true;
    const handler: RunHandler = {
      async execute(ctx) {
        await ctx.once(1, 'tool_call', {}, async () => {
          effects += 1;
          return 'written';
        });
        if (crash) {
          crash = false;
          // Simulate the process dying: never return, and stop renewing.
          return new Promise(() => undefined);
        }
        return { kind: 'done' };
      },
    };
    const { store, worker } = setup(handler);
    await store.create({
      id: 'run_b',
      kind: 'agent',
      traceId: 't'.repeat(32),
      threadId: null,
      messageId: null,
      checkpoint: {},
    });
    await worker.start();
    await until(async () => effects === 1);
    worker.stop(); // the "dead" worker

    // A minute later its lease has lapsed; the sweeper puts it back in the queue.
    const { sweep } = await import('../../src/runs/engine');
    expect((await sweep(store, new Date(Date.now() + 60_000))).requeued).toEqual(['run_b']);
    const next = new RunWorker({
      store,
      events: new MemoryRunEventLog(),
      handlers: { agent: handler },
      pollMs: 10,
      sweepMs: 60_000,
    });
    await next.start();
    await until(async () => (await store.get('run_b'))?.status === 'succeeded');
    expect(effects).toBe(1);
    expect((await store.get('run_b'))?.attempt).toBe(1);
    next.stop();
  });

  it('fails a run that keeps killing its worker instead of retrying forever', async () => {
    const store = new MemoryRunStore();
    await store.create({
      id: 'run_c',
      kind: 'agent',
      traceId: 't'.repeat(32),
      threadId: null,
      messageId: null,
      checkpoint: {},
    });
    const run = await store.get('run_c');
    if (!run) throw new Error('run_c missing');
    await store.save({ ...run, status: 'running', attempt: 4 }, { status: 'queued' });
    const { sweep } = await import('../../src/runs/engine');
    await sweep(store, new Date(Date.now() + 60_000));
    expect((await store.get('run_c'))?.status).toBe('failed');
  });

  it('cancels a waiting run and lets its handler tidy up', async () => {
    let tidied = false;
    const { store, events, worker } = setup({
      execute: async () => ({ kind: 'pause', reason: 'approval', checkpoint: { waiting: true } }),
      cancelled: async () => {
        tidied = true;
      },
    });
    await store.create({
      id: 'run_d',
      kind: 'agent',
      traceId: 't'.repeat(32),
      threadId: null,
      messageId: null,
      checkpoint: {},
    });
    await worker.start();
    await until(async () => (await store.get('run_d'))?.status === 'waiting_approval');
    expect(await worker.cancel('run_d')).toBe('cancelled');
    expect((await store.get('run_d'))?.status).toBe('cancelled');
    expect(tidied).toBe(true);
    expect((await events.since('run_d', 0)).at(-1)?.type).toBe('done');
    worker.stop();
  });

  it('resumes a paused run from its checkpoint', async () => {
    const seen: unknown[] = [];
    const { store, worker } = setup({
      async execute(ctx) {
        seen.push(ctx.run.checkpoint);
        if ((ctx.run.checkpoint as { step: number }).step === 0)
          return { kind: 'pause', reason: 'approval', checkpoint: { step: 1 } };
        return { kind: 'done' };
      },
    });
    await store.create({
      id: 'run_e',
      kind: 'agent',
      traceId: 't'.repeat(32),
      threadId: null,
      messageId: null,
      checkpoint: { step: 0 },
    });
    await worker.start();
    await until(async () => (await store.get('run_e'))?.status === 'waiting_approval');
    expect(await worker.resume('run_e')).toBe(true);
    await until(async () => (await store.get('run_e'))?.status === 'succeeded');
    expect(seen).toEqual([{ step: 0 }, { step: 1 }]);
    worker.stop();
  });

  it('marks a crashing handler as failed with a plain message', async () => {
    const { store, events, worker } = setup({
      execute: async () => {
        throw new Error('boom');
      },
    });
    await store.create({
      id: 'run_f',
      kind: 'agent',
      traceId: 't'.repeat(32),
      threadId: null,
      messageId: null,
      checkpoint: {},
    });
    await worker.start();
    await until(async () => (await store.get('run_f'))?.status === 'failed');
    expect((await store.get('run_f'))?.error).toMatchObject({ code: 'run.crashed' });
    expect((await events.since('run_f', 0)).at(-1)?.type).toBe('done');
    worker.stop();
  });
});
