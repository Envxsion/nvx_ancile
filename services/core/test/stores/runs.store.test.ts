/**
 * Durable runs (DESIGN.md §7.5): leases, compare-and-set saves, the sweeper's
 * view and idempotent steps, plus the run event log, from both backends.
 */
import { beforeEach, expect, it } from 'vitest';
import type { RunRecord, RunStore } from '../../src/runs/engine';
import { MemoryRunEventLog, PgRunEventLog, type RunEventLog } from '../../src/runs/events';
import { MemoryRunStore, PgRunStore } from '../../src/runs/store';
import { MemoryThreadRepo, PgThreadRepo, type ThreadRepo } from '../../src/threads/repo';
import { eachBackend, uid } from '../support/stores';

eachBackend('run store and event log', (backend) => {
  let runs: RunStore;
  let events: RunEventLog;
  let threads: ThreadRepo;
  let ws: string;

  beforeEach(() => {
    const b = backend();
    ws = b.owner.workspaceId;
    runs = b.sql ? new PgRunStore(b.sql) : new MemoryRunStore();
    events = b.sql ? new PgRunEventLog(b.sql) : new MemoryRunEventLog();
    threads = b.sql ? new PgThreadRepo(b.sql) : new MemoryThreadRepo();
  });

  const newRun = (threadId: string | null = null) =>
    runs.create({
      id: uid('run'),
      kind: 'chat_turn',
      traceId: '1'.repeat(32),
      threadId,
      messageId: null,
      checkpoint: { step: 0 },
    });

  /** Claim until this run comes up: other tests may have left queued runs. */
  const claimThis = async (id: string, owner: string): Promise<RunRecord> => {
    for (let i = 0; i < 50; i++) {
      const got = await runs.claim(owner, 30_000);
      if (!got) break;
      if (got.id === id) return got;
      await runs.save({ ...got, status: 'cancelled' }, { status: 'running', owner });
    }
    throw new Error(`run ${id} was never claimed`);
  };

  it('creates a queued run and claims it under a lease that can be renewed', async () => {
    const run = await newRun();
    expect(run).toMatchObject({ status: 'queued', attempt: 0, stepCursor: 0, checkpoint: { step: 0 } });
    expect((await runs.get(run.id))?.status).toBe('queued');

    const claimed = await claimThis(run.id, 'wkr_a');
    expect(claimed).toMatchObject({ status: 'running', leaseOwner: 'wkr_a' });
    expect(await runs.renew(run.id, 'wkr_a', 30_000)).toBe(true);
    expect(await runs.renew(run.id, 'wkr_b', 30_000)).toBe(false);
  });

  it('claims a burst several at a time, oldest first, each exactly once', async () => {
    // Other test files share this database and queue runs of their own:
    // judge only ours, wherever they land among the claims.
    const made = [];
    for (let i = 0; i < 3; i++) made.push(await newRun());
    const ours = new Set(made.map((r) => r.id));
    const claimed: string[] = [];
    for (let round = 0; round < 50 && claimed.filter((id) => ours.has(id)).length < 3; round++) {
      const batch = (await runs.claimMany?.(`wkr_${round}`, 30_000, 2)) ?? [];
      if (!batch.length) break;
      expect(batch.length).toBeLessThanOrEqual(2);
      expect(batch.every((r) => r.status === 'running')).toBe(true);
      claimed.push(...batch.map((r) => r.id));
    }
    const mine = claimed.filter((id) => ours.has(id));
    expect(mine).toEqual(made.map((r) => r.id));
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it('saves only while the stored run still matches, and clears the lease when it stops running', async () => {
    const run = await newRun();
    const claimed = await claimThis(run.id, 'wkr_a');
    const next = { ...claimed, stepCursor: 2, checkpoint: { step: 2 } };
    expect(await runs.save(next, { status: 'running', owner: 'wkr_b' })).toBe(false);
    expect(await runs.save(next, { status: 'running', owner: 'wkr_a' })).toBe(true);
    expect((await runs.get(run.id))?.checkpoint).toEqual({ step: 2 });

    expect(await runs.save({ ...next, status: 'succeeded' }, { status: 'running', owner: 'wkr_a' })).toBe(
      true,
    );
    const done = await runs.get(run.id);
    expect(done?.status).toBe('succeeded');
    expect(done?.leaseOwner ?? null).toBeNull();
    // A second writer that still thinks it is running has lost the run.
    expect(await runs.save({ ...next, status: 'failed' }, { status: 'running', owner: 'wkr_a' })).toBe(false);
  });

  it('finds lapsed leases for the sweeper, and a thread’s active and past runs', async () => {
    const thread = uid('thr');
    await threads.createThread({ id: thread, workspace_id: ws });
    // An earlier fact-check in the thread, finished.
    const check = await runs.create({
      id: uid('run'),
      kind: 'factcheck',
      traceId: '2'.repeat(32),
      threadId: thread,
      messageId: null,
      checkpoint: {},
    });
    const claimedCheck = await claimThis(check.id, 'wkr_a');
    await runs.save({ ...claimedCheck, status: 'succeeded' }, { status: 'running', owner: 'wkr_a' });

    const run = await newRun(thread);
    // One active run per thread: a second is refused while the first is live.
    await expect(newRun(thread)).rejects.toMatchObject({ code: 'run.already_running' });
    await claimThis(run.id, 'wkr_a');
    // A lease of 1 ms has lapsed by the time we look.
    await runs.renew(run.id, 'wkr_a', 1);
    await new Promise((r) => setTimeout(r, 20));
    expect((await runs.expiredLeases(new Date())).map((r) => r.id)).toContain(run.id);

    expect((await runs.activeForThread(thread)).map((r) => r.id)).toContain(run.id);
    expect((await runs.forThread(thread, 'factcheck')).length).toBe(1);
    expect((await runs.withStatus('running')).map((r) => r.id)).toContain(run.id);
  });

  it('records each step once, by its sequence', async () => {
    const run = await newRun();
    expect(await runs.step(run.id, 1)).toBeUndefined();
    const step = {
      runId: run.id,
      seq: 1,
      kind: 'tool',
      idempotencyKey: `${run.id}:1`,
      status: 'in_progress' as const,
      input: { path: 'a.md' },
      output: null,
    };
    await runs.putStep(step);
    await runs.putStep({ ...step, status: 'succeeded', output: { ok: true } });
    expect(await runs.step(run.id, 1)).toMatchObject({
      status: 'succeeded',
      output: { ok: true },
      input: { path: 'a.md' },
    });
  });

  it('numbers events in order, replays them after a point, and tells subscribers', async () => {
    const run = await newRun();
    const seen: number[] = [];
    const off = events.subscribe(run.id, (e) => seen.push(e.seq));
    const appended = await Promise.all([
      events.append(run.id, { type: 'text.delta', message_id: 'msg_x', delta: 'one ' }),
      events.append(run.id, { type: 'text.delta', message_id: 'msg_x', delta: 'two ' }),
      events.append(run.id, { type: 'text.delta', message_id: 'msg_x', delta: 'three' }),
    ]);
    off();
    expect(appended.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(seen).toEqual([1, 2, 3]);
    const after = await events.since(run.id, 1);
    expect(after.map((e) => (e as { delta: string }).delta)).toEqual(['two ', 'three']);
    await events.append(run.id, { type: 'text.delta', message_id: 'msg_x', delta: '!' });
    expect(seen).toEqual([1, 2, 3]);
  });
});
