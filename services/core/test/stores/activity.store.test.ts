/**
 * The Activity panel's run progress on Postgres: the latest step, fact-check
 * or flow event per unfinished run, from core.run_events.
 */
import { expect, it } from 'vitest';
import { pgRunProgress } from '../../src/activity/progress';
import { ActivityService } from '../../src/activity/service';
import { PgRunEventLog } from '../../src/runs/events';
import { PgRunStore } from '../../src/runs/store';
import { eachBackend, uid } from '../support/stores';

eachBackend('activity run progress', (backend) => {
  it('reads the latest progress event per run, and lists the run with it', async () => {
    const { sql } = backend();
    if (!sql) return; // Postgres only: the memory backend has no event table.
    const runs = new PgRunStore(sql);
    const log = new PgRunEventLog(sql);
    const a = uid('run');
    const b = uid('run');
    await runs.create({
      id: a,
      kind: 'research',
      traceId: '1'.repeat(32),
      threadId: null,
      messageId: null,
      checkpoint: null,
    });
    await runs.create({
      id: b,
      kind: 'factcheck',
      traceId: '1'.repeat(32),
      threadId: null,
      messageId: null,
      checkpoint: null,
    });
    await log.append(a, { type: 'step.started', step: 1, kind: 'retrieval', label: 'Searching sources' });
    await log.append(a, { type: 'text.delta', message_id: 'm', delta: 'x' });
    await log.append(a, { type: 'step.started', step: 2, kind: 'model_call', label: 'Writing the report' });
    await log.append(b, {
      type: 'factcheck.progress',
      factcheck_id: 'f',
      message_id: 'm',
      stage: 'verifying',
      done: 2,
      total: 5,
    });
    const progress = await pgRunProgress(sql)([a, b, uid('run')]);
    expect(progress.get(a)).toEqual({ label: 'Writing the report' });
    expect(progress.get(b)).toEqual({ label: 'Checking claims', done: 2, total: 5 });
    expect(progress.size).toBe(2);

    const svc = new ActivityService({ runs, runProgress: pgRunProgress(sql), threadTitle: async () => null });
    const items = (await svc.list()).items.filter((i) => i.id === `run:${a}` || i.id === `run:${b}`);
    expect(items.map((i) => i.detail).sort()).toEqual(['Queued', 'Queued']);
    for (const id of [a, b]) {
      const r = await runs.get(id);
      if (r) await runs.save({ ...r, status: 'cancelled' }, { status: 'queued' });
    }
  });
});
