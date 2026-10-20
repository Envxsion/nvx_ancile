/**
 * One sender per thread (threads/send-lock.ts), on both backends: two
 * windows taking the lock at once get exactly one winner; it is held while
 * the run its send started is active and comes free when the run ends; a
 * send that crashed before starting a run frees it when its lease runs out.
 */
import { beforeEach, expect, it } from 'vitest';
import type { RunStore } from '../../src/runs/engine';
import { MemoryRunStore, PgRunStore } from '../../src/runs/store';
import { MemorySendLocks, PgSendLocks, type SendLocks, withSendLock } from '../../src/threads/send-lock';
import { eachBackend, uid } from '../support/stores';

eachBackend('per-thread send lock', (backend) => {
  let locks: SendLocks;
  let runs: RunStore;
  let pg: boolean;

  beforeEach(() => {
    const b = backend();
    pg = !!b.sql;
    runs = b.sql ? new PgRunStore(b.sql) : new MemoryRunStore();
    locks = b.sql ? new PgSendLocks(b.sql) : new MemorySendLocks(runs);
  });

  const run = async (status: 'queued' | 'succeeded' = 'queued') => {
    const r = await runs.create({
      id: uid('run'),
      kind: 'chat_turn',
      traceId: '1'.repeat(32),
      threadId: null,
      messageId: null,
      checkpoint: {},
    });
    if (status !== 'queued') await runs.save({ ...r, status }, { status: 'queued' });
    return r.id;
  };

  it('lets exactly one of many windows in at once', async () => {
    const thread = uid('thr');
    const tries = await Promise.all(
      Array.from({ length: 8 }, (_, i) => locks.acquire(thread, `win:window-${i}`)),
    );
    expect(tries.filter((t) => t.ok)).toHaveLength(1);
    const lost = tries.find((t) => !t.ok);
    expect(lost && !lost.ok && lost.holder.startsWith('win:window-')).toBe(true);
  });

  it('is the same window’s again, and holds while its run is active', async () => {
    const thread = uid('thr');
    expect((await locks.acquire(thread, 'win:aaaaaaaa')).ok).toBe(true);
    expect((await locks.acquire(thread, 'win:aaaaaaaa')).ok).toBe(true);
    const r = await run();
    await locks.attach(thread, 'win:aaaaaaaa', r);
    expect((await locks.acquire(thread, 'win:bbbbbbbb')).ok).toBe(false);
    // A failed second send from the first window does not let go while its run is active.
    await locks.release(thread, 'win:aaaaaaaa');
    expect((await locks.acquire(thread, 'win:bbbbbbbb')).ok).toBe(false);
    // The run ends: the lock is free, with nothing to clean up.
    const rec = await runs.get(r);
    if (rec) await runs.save({ ...rec, status: 'cancelled' }, { status: 'queued' });
    expect((await locks.acquire(thread, 'win:bbbbbbbb')).ok).toBe(true);
  });

  it('comes free when a send crashed before starting a run (its lease ran out)', async () => {
    const thread = uid('thr');
    expect((await locks.acquire(thread, 'win:crashed1', 1)).ok).toBe(true);
    await new Promise((r) => setTimeout(r, pg ? 30 : 5));
    expect((await locks.acquire(thread, 'win:another1')).ok).toBe(true);
  });

  it('a run that already ended does not hold it', async () => {
    const thread = uid('thr');
    expect((await locks.acquire(thread, 'win:aaaaaaaa')).ok).toBe(true);
    await locks.attach(thread, 'win:aaaaaaaa', await run('succeeded'));
    expect((await locks.acquire(thread, 'win:bbbbbbbb')).ok).toBe(true);
  });

  it('withSendLock: a second window hears thread.busy; a failed send lets go at once', async () => {
    const thread = uid('thr');
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = withSendLock(locks, thread, 'win:first111', async () => {
      await gate;
      return { run_id: await run() };
    });
    await new Promise((r) => setTimeout(r, pg ? 50 : 5));
    await expect(
      withSendLock(locks, thread, 'win:second11', async () => ({ run_id: 'never' })),
    ).rejects.toMatchObject({ code: 'thread.busy', status: 409 });
    release();
    await first;

    const other = uid('thr');
    await expect(
      withSendLock(locks, other, 'win:failing1', async () => {
        throw new Error('model refused');
      }),
    ).rejects.toThrow('model refused');
    expect((await locks.acquire(other, 'win:next1111')).ok).toBe(true);
  });

  it('a turn paused on an approval says so, not "another window"', async () => {
    const thread = uid('thr');
    expect((await locks.acquire(thread, 'win:aaaaaaaa')).ok).toBe(true);
    const r = await run();
    await locks.attach(thread, 'win:aaaaaaaa', r);
    const rec = await runs.get(r);
    if (rec) await runs.save({ ...rec, status: 'waiting_approval' }, { status: 'queued' });
    await expect(
      withSendLock(locks, thread, 'win:bbbbbbbb', async () => ({ run_id: 'never' })),
    ).rejects.toMatchObject({
      code: 'thread.busy',
      title: 'Waiting for your approval',
      context: { reason: 'approval' },
    });
  });
});
