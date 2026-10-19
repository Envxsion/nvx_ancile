import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AncileError, type system } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scheduledJobs } from '../../src/automations/jobs';
import { IDLE_MINUTES, type TidyDeps, tidyStorage } from '../../src/system/tidy';

let dataDir: string;
beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ancile-tidy-'));
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const NOW = new Date('2026-10-19T03:30:00Z');
const roomy = async () => ({ bavail: 1_000_000_000, bsize: 4096 });
const tight = async () => ({ bavail: 100, bsize: 4096 });

function rig(over: Partial<TidyDeps> = {}) {
  const calls: string[] = [];
  const posts: unknown[] = [];
  const sql = (async () => [{ n: '5000000' }]) as unknown as Sql;
  const deps: TidyDeps = {
    sql,
    dataDir,
    now: () => NOW,
    statfs: roomy,
    activeRuns: async () => 0,
    lastRunActivity: async () => null,
    backup: async () => {
      calls.push('backup');
      return { name: 'ancile-20261019-before-tidy.dump' };
    },
    kn: {
      post: (async (path: string, b: unknown) => {
        calls.push('tidy');
        posts.push([path, b]);
        return { chunks_removed: 12, parents_removed: 2, bodies_linked: 3, bodies_bytes: 4096 };
      }) as never,
    },
    vacuum: async () => {
      calls.push('vacuum');
    },
    ...over,
  };
  return { deps, calls, posts };
}

const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as AncileError;
  }
  throw new Error('expected it to fail');
};

describe('Tidy storage (MT1)', () => {
  it('backs up first, then dedupes, then vacuums, and says what it did', async () => {
    const { deps, calls, posts } = rig();
    const r = await tidyStorage(deps);
    expect(calls).toEqual(['backup', 'tidy', 'vacuum']);
    expect(posts).toEqual([['/maintenance/tidy', { dry_run: false }]]);
    expect(r).toMatchObject({
      dry_run: false,
      backup: 'ancile-20261019-before-tidy.dump',
      chunks_removed: 12,
      parents_removed: 2,
      bodies_linked: 3,
      bytes_freed: 4096,
      vacuumed: true,
    });
    expect(r.summary).toMatch(/Removed 12 duplicate chunks and 2 empty parents/);
    expect(r.summary).toMatch(/A backup was taken first/);
  });

  it('refuses while a run is active and changes nothing, not even a backup', async () => {
    const { deps, calls } = rig({ activeRuns: async () => 2 });
    const e = await fails(tidyStorage(deps));
    expect(e).toBeInstanceOf(AncileError);
    expect(e.code).toBe('maintenance.busy');
    expect(e.hint).toMatch(/2 runs are in progress/);
    expect(calls).toEqual([]);
  });

  it('a run that starts while the backup is taken stops it before anything is removed', async () => {
    let n = 0;
    const { deps, calls } = rig({ activeRuns: async () => (n++ === 0 ? 0 : 1) });
    const e = await fails(tidyStorage(deps));
    expect(e.code).toBe('maintenance.busy');
    expect(e.title).toMatch(/started while the backup/);
    expect(calls).toEqual(['backup']);
  });

  it('the automation waits for quiet: not within the idle time of a run, fine after it', async () => {
    const recent = new Date(NOW.getTime() - 3 * 60_000);
    const first = rig({ lastRunActivity: async () => recent });
    const e = await fails(tidyStorage(first.deps, { idleMinutes: IDLE_MINUTES }));
    expect(e.code).toBe('maintenance.busy');
    expect(first.calls).toEqual([]);

    const later = rig({ lastRunActivity: async () => new Date(NOW.getTime() - 30 * 60_000) });
    await tidyStorage(later.deps, { idleMinutes: IDLE_MINUTES });
    expect(later.calls).toEqual(['backup', 'tidy', 'vacuum']);

    // By hand there is no idle wait, only "not during a run".
    const hand = rig({ lastRunActivity: async () => recent });
    await tidyStorage(hand.deps);
    expect(hand.calls).toContain('tidy');
  });

  it('checks free disk space before the backup and aborts if there is not enough', async () => {
    const { deps, calls } = rig({ statfs: tight });
    const e = await fails(tidyStorage(deps));
    expect(e.code).toBe('system.disk_full');
    expect(calls).toEqual([]);
  });

  it('a dry run counts what it would do: no backup, no vacuum, nothing removed', async () => {
    const { deps, calls, posts } = rig({ statfs: tight });
    const r = await tidyStorage(deps, { dryRun: true });
    expect(calls).toEqual(['tidy']);
    expect(posts).toEqual([['/maintenance/tidy', { dry_run: true }]]);
    expect(r).toMatchObject({ dry_run: true, backup: null, vacuumed: false, chunks_removed: 12 });
    expect(r.summary).toMatch(/Would remove 12 duplicate chunks/);
    expect(r.summary).not.toMatch(/backup/);
  });

  it('a failed backup stops everything', async () => {
    const { deps, calls } = rig({
      backup: async () => {
        throw new AncileError({
          code: 'system.backup_failed',
          title: 'The database could not be backed up',
          hint: 'Your data was not changed.',
          status: 503,
          errorClass: 'permanent',
        });
      },
    });
    const e = await fails(tidyStorage(deps));
    expect(e.code).toBe('system.backup_failed');
    expect(calls).toEqual([]);
  });

  it('says plainly when there was nothing to remove', async () => {
    const { deps } = rig({
      kn: {
        post: (async () => ({
          chunks_removed: 0,
          parents_removed: 0,
          bodies_linked: 0,
          bodies_bytes: 0,
        })) as never,
      },
    });
    expect((await tidyStorage(deps)).summary).toMatch(/^Nothing was duplicated, so nothing was removed\./);
  });
});

describe('the Tidy storage automation', () => {
  const job = (tidy: (o: { idleMinutes: number }) => Promise<system.TidyReport>) =>
    scheduledJobs({
      obs: {} as never,
      memoryDir: dataDir,
      retention: { logsDays: 1, spansDays: 1, runEventsDays: 1 },
      tidy,
    }).tidy_storage as NonNullable<ReturnType<typeof scheduledJobs>['tidy_storage']>;
  const ctx = { id: 'tidy_storage', title: 'Tidy storage' };

  it('runs with the idle wait and reports the summary', async () => {
    let seen = -1;
    const r = await job(async (o) => {
      seen = o.idleMinutes;
      return { summary: 'Removed 1 duplicate chunk.' } as system.TidyReport;
    })({}, new AbortController().signal, ctx as never);
    expect(seen).toBe(IDLE_MINUTES);
    expect(r).toEqual({ status: 'succeeded', detail: 'Removed 1 duplicate chunk.' });
  });

  it('is skipped, not failed, when something is running', async () => {
    const busy = new AncileError({
      code: 'maintenance.busy',
      title: "Storage can't be tidied while something is running",
      hint: 'Wait.',
      status: 409,
      errorClass: 'transient',
    });
    const r = await job(async () => {
      throw busy;
    })({}, new AbortController().signal, ctx as never);
    expect(r.status).toBe('skipped');
    expect(r.detail).toMatch(/try again at the next time/);
  });

  it('fails loudly on a full disk', async () => {
    const full = new AncileError({
      code: 'system.disk_full',
      title: 'Not enough free disk space',
      hint: 'Free some space.',
      status: 507,
      errorClass: 'capacity',
    });
    await expect(
      job(async () => {
        throw full;
      })({}, new AbortController().signal, ctx as never),
    ).rejects.toBe(full);
  });
});
