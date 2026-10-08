/**
 * Phase 5: cron schedules, the automations runner, and the self-diagnostic.
 */
import { describe, expect, it } from 'vitest';
import { cronWords, nextRun, parseCron } from '../../src/automations/cron';
import { AutomationRunner, MemoryAutomationStore } from '../../src/automations/runner';
import { type CheckSpec, DiagnosticRunner } from '../../src/diagnostics/runner';

const at = (s: string) => new Date(s);
const iso = (d: Date | null) => {
  if (!d) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

describe('cron', () => {
  it('finds the next minute a schedule allows (local time)', () => {
    const from = at('2026-10-08T10:17:30');
    expect(iso(nextRun(parseCron('*/15 * * * *'), from))).toBe('2026-10-08 10:30');
    expect(iso(nextRun(parseCron('0 3 * * *'), from))).toBe('2026-10-09 03:00');
    expect(iso(nextRun(parseCron('0 4 * * 1'), from))).toBe('2026-10-12 04:00'); // Monday
    expect(iso(nextRun(parseCron('0 * * * *'), at('2026-10-08T10:00:00')))).toBe('2026-10-08 11:00');
    expect(iso(nextRun(parseCron('30 9 1 1 *'), from))).toBe('2027-01-01 09:30');
  });

  it('matches either day field when both are restricted', () => {
    // the 13th, or any Friday
    expect(iso(nextRun(parseCron('0 0 13 * 5'), at('2026-10-08T10:00:00')))).toBe('2026-10-09 00:00');
  });

  it('rejects schedules it cannot read', () => {
    expect(() => parseCron('* * *')).toThrow(/five fields/);
    expect(() => parseCron('61 * * * *')).toThrow(/out of range/);
    expect(() => parseCron('x * * * *')).toThrow(/not a valid/);
  });

  it('says common schedules in words', () => {
    expect(cronWords('*/15 * * * *')).toBe('Every 15 minutes');
    expect(cronWords('0 * * * *')).toBe('Every hour');
    expect(cronWords('0 3 * * *')).toBe('Every day at 03:00');
    expect(cronWords('0 4 * * 1')).toBe('Every Monday at 04:00');
    expect(cronWords('5 4 1 * *')).toBe('5 4 1 * *');
  });
});

describe('automations', () => {
  it('runs what is due once, records it, and moves the next run on', async () => {
    let now = at('2026-10-08T02:59:00');
    const ran: string[] = [];
    const store = new MemoryAutomationStore();
    const runner = new AutomationRunner(
      {
        cleanup: { enabled: true, cron: '0 3 * * *', config: {} },
        auto_title: { enabled: true, config: {} },
      },
      {
        cleanup: async () => {
          ran.push('cleanup');
          return { status: 'succeeded', detail: 'Removed 3 log lines.' };
        },
      },
      store,
      () => now,
    );
    await runner.start(60_000);
    runner.stop();
    await runner.tick();
    expect(ran).toEqual([]);
    now = at('2026-10-08T03:00:10');
    await runner.tick();
    await runner.tick();
    expect(ran).toEqual(['cleanup']);
    const views = await runner.views();
    const cleanup = views.find((v) => v.id === 'cleanup');
    expect(cleanup).toMatchObject({
      last_status: 'succeeded',
      runs: 1,
      schedule_words: 'Every day at 03:00',
    });
    expect(iso(new Date(cleanup?.next_run_at ?? 0))).toBe('2026-10-09 03:00');
    expect(views.find((v) => v.id === 'auto_title')?.trigger).toBe('event');
  });

  it('keeps going when a job fails, and says why', async () => {
    const store = new MemoryAutomationStore();
    const runner = new AutomationRunner(
      { cleanup: { enabled: true, cron: '0 3 * * *', config: {} } },
      {
        cleanup: async () => {
          throw new Error('disk is read-only');
        },
      },
      store,
    );
    await runner.start(60_000);
    runner.stop();
    expect(await runner.runNow('cleanup')).toBe('failed');
    const v = (await runner.views())[0];
    expect(v?.last_error).toBe('disk is read-only');
    await runner.setEnabled('cleanup', false);
    expect((await runner.views())[0]?.next_run_at).toBeNull();
  });
});

describe('self-diagnostic', () => {
  it('runs every check, streams results, and fails when any check fails', async () => {
    const checks: CheckSpec[] = [
      { id: 'a', group: 'data', title: 'A', run: async () => ({ status: 'passed', detail: 'fine' }) },
      {
        id: 'b',
        group: 'system',
        title: 'B',
        fix: 'Do the thing.',
        run: async () => {
          throw new Error('broke');
        },
      },
      {
        id: 'c',
        group: 'models',
        title: 'C',
        run: async () => ({ status: 'warned', detail: 'meh', fix: 'Tune it.' }),
      },
      {
        id: 'd',
        group: 'system',
        title: 'D',
        timeoutMs: 30,
        run: () => new Promise(() => undefined),
      },
    ];
    const saved: string[] = [];
    const runner = new DiagnosticRunner(() => checks, {
      save: async (r) => void saved.push(r.status),
      recent: async () => [],
    });
    const run = runner.start();
    const seen: string[] = [];
    runner.subscribe(run.id, 0, (e) =>
      seen.push(e.type === 'check' ? `${e.check.id}:${e.check.status}` : 'done'),
    );
    const done = await runner.settle(run.id);
    expect(done?.status).toBe('failed');
    const byId = Object.fromEntries((done?.checks ?? []).map((c) => [c.id, c]));
    expect(byId.a?.status).toBe('passed');
    expect(byId.b).toMatchObject({ status: 'failed', detail: 'broke', fix: 'Do the thing.' });
    expect(byId.c).toMatchObject({ status: 'warned', fix: 'Tune it.' });
    expect(byId.d?.detail).toMatch(/did not finish/);
    expect(seen.at(-1)).toBe('done');
    expect(seen).toContain('b:failed');
    expect(saved).toEqual(['failed']);
  });
});
