/**
 * Restore from the setup step (ROADMAP SU1), without a database: the choice is a
 * marker, nothing changes until the restart, a restore a restart interrupted
 * carries on without a second safety copy, and a failure says what to do.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupsDir } from '../../src/db/backup';
import { bootRestore } from '../../src/system/bootRestore';
import {
  applyStaged,
  clearStaged,
  mustApply,
  readStaged,
  requestApply,
  stageRestore,
} from '../../src/system/stagedRestore';
import { RESTART_ALL_EXIT, startupRoutes, startupStatus } from '../../src/system/startup';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ancile-staged-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tools = { dump: 'pg_dump', restore: 'pg_restore', from: 'pg0' as const };

function putBackup(dataDir: string, name: string, reason = 'manual', at = '2026-10-01T00:00:00Z') {
  mkdirSync(backupsDir(dataDir), { recursive: true });
  writeFileSync(join(backupsDir(dataDir), name), 'PGDMP fake');
  writeFileSync(
    join(backupsDir(dataDir), `${name}.json`),
    JSON.stringify({ name, created_at: at, reason, bytes: 10, app_version: '0.1.1', core_schema: null }),
  );
}

/** A database that answers the size query, schemas to drop, and one transaction. */
function fakeSql(): Sql {
  const tx = Object.assign((..._: unknown[]) => Promise.resolve([{ nspname: 'core' }]), {
    unsafe: () => Promise.resolve([]),
  });
  return Object.assign((..._: unknown[]) => Promise.resolve([{ n: '1024', v: '180001' }]), {
    begin: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  }) as unknown as Sql;
}

const deps = (dataDir: string, run: (cmd: string, args: string[]) => number = () => 0) => ({
  sql: fakeSql(),
  url: 'postgres://a:b@127.0.0.1:1/x',
  dataDir,
  version: '0.1.1',
  schema: () => ({ expected: '0020_x.sql', current: null }),
  tools,
  statfs: async () => ({ bavail: 1e9, bsize: 4096 }),
  run: async (cmd: string, args: string[]) => {
    const file = args.find((a) => a.startsWith('--file='))?.slice(7);
    if (file) writeFileSync(file, 'PGDMP safety');
    return { code: run(cmd, args), stdout: '', stderr: 'could not read the file', timedOut: false };
  },
});

describe('choosing a backup in setup', () => {
  it('only writes a marker: nothing is applied until the restart is asked for', async () => {
    const dataDir = tmp();
    putBackup(dataDir, 'ancile-1.dump');
    const m = await stageRestore(dataDir, 'ancile-1.dump');
    expect(m).toMatchObject({ backup: 'ancile-1.dump', state: 'staged', attempts: 0, bytes: 10 });
    expect(mustApply(await readStaged(dataDir))).toBe(false);
    await requestApply(dataDir);
    expect(mustApply(await readStaged(dataDir))).toBe(true);
  });

  it('takes a name from the list, never a path or a name that is not there', async () => {
    const dataDir = tmp();
    putBackup(dataDir, 'ancile-1.dump');
    await expect(stageRestore(dataDir, '../../etc/passwd')).rejects.toMatchObject({
      code: 'system.backup_not_found',
    });
  });

  it('can be dropped again, but not while it is being applied', async () => {
    const dataDir = tmp();
    putBackup(dataDir, 'ancile-1.dump');
    await stageRestore(dataDir, 'ancile-1.dump');
    await clearStaged(dataDir);
    expect(await readStaged(dataDir)).toBeNull();
    await stageRestore(dataDir, 'ancile-1.dump');
    await requestApply(dataDir);
    await expect(clearStaged(dataDir)).rejects.toMatchObject({ code: 'system.restore_in_progress' });
    await expect(stageRestore(dataDir, 'ancile-1.dump')).rejects.toMatchObject({
      code: 'system.restore_in_progress',
    });
  });

  it('says there is nothing to apply when nothing was chosen', async () => {
    await expect(requestApply(tmp())).rejects.toMatchObject({ code: 'system.restore_not_staged' });
  });
});

describe('applying it at the next start', () => {
  it('takes a safety copy, restores, and ends done', async () => {
    const dataDir = tmp();
    putBackup(dataDir, 'ancile-1.dump');
    await stageRestore(dataDir, 'ancile-1.dump');
    await requestApply(dataDir);
    const calls: string[] = [];
    const done = await applyStaged(
      deps(dataDir, (cmd) => {
        calls.push(cmd);
        return 0;
      }),
    );
    expect(done).toMatchObject({ state: 'done', step: 'done', attempts: 1, error: null });
    expect(done?.safety).toMatch(/before-restore\.dump$/);
    expect(calls).toEqual(['pg_dump', 'pg_restore']);
  });

  it('keeps the reason and the safety copy when the backup cannot be read, and can be tried again', async () => {
    const dataDir = tmp();
    putBackup(dataDir, 'ancile-1.dump');
    await stageRestore(dataDir, 'ancile-1.dump');
    await requestApply(dataDir);
    const failed = await applyStaged(deps(dataDir, (cmd) => (cmd === 'pg_restore' ? 1 : 0)));
    expect(failed?.state).toBe('failed');
    expect(failed?.error?.title).toBe('The backup could not be restored');
    expect(failed?.safety).not.toBeNull();
    // Trying again does not take a second safety copy of a database that was cleared.
    await requestApply(dataDir);
    const calls: string[] = [];
    const again = await applyStaged(
      deps(dataDir, (cmd) => {
        calls.push(cmd);
        return 0;
      }),
    );
    expect(calls).toEqual(['pg_restore']);
    // Asking again starts the count of tries afresh.
    expect(again).toMatchObject({ state: 'done', attempts: 1 });
  });

  it('gives up after three starts in a row that it took down, and can still be asked again', async () => {
    const dataDir = tmp();
    putBackup(dataDir, 'ancile-1.dump');
    await stageRestore(dataDir, 'ancile-1.dump');
    const path = join(backupsDir(dataDir), 'restore-staged.json');
    const m = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...m, state: 'running', step: 'restoring', attempts: 3 }));
    const calls: string[] = [];
    const out = await applyStaged(
      deps(dataDir, (cmd) => {
        calls.push(cmd);
        return 0;
      }),
    );
    expect(calls).toEqual([]);
    expect(out).toMatchObject({ state: 'failed', attempts: 3 });
    expect(out?.error?.hint).toMatch(/3 times in a row/);
    expect(mustApply(await readStaged(dataDir))).toBe(false);
    expect(await requestApply(dataDir)).toMatchObject({ state: 'restarting', attempts: 0 });
  });

  it('carries on after a restart that interrupted it, once and from the marker', async () => {
    const dataDir = tmp();
    putBackup(dataDir, 'ancile-1.dump');
    putBackup(dataDir, 'ancile-safety.dump', 'before-restore', '2026-10-02T00:00:00Z');
    await stageRestore(dataDir, 'ancile-1.dump');
    // The marker as an interrupted restore leaves it: running, past the safety copy.
    const path = join(backupsDir(dataDir), 'restore-staged.json');
    const m = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(
      path,
      JSON.stringify({
        ...m,
        state: 'running',
        step: 'restoring',
        attempts: 1,
        safety: 'ancile-safety.dump',
      }),
    );
    expect(mustApply(await readStaged(dataDir))).toBe(true);
    const calls: string[] = [];
    const done = await applyStaged(
      deps(dataDir, (cmd) => {
        calls.push(cmd);
        return 0;
      }),
    );
    expect(calls).toEqual(['pg_restore']);
    expect(done).toMatchObject({ state: 'done', attempts: 2, safety: 'ancile-safety.dump' });
  });

  it('shows its progress on the start-up screen, and the desktop app starts again when done', async () => {
    const dataDir = tmp();
    putBackup(dataDir, 'ancile-1.dump');
    await stageRestore(dataDir, 'ancile-1.dump');
    await requestApply(dataDir);
    const exits: number[] = [];
    let fetch: ((r: Request) => Response | Promise<Response>) | null = null;
    vi.useFakeTimers();
    try {
      await bootRestore({
        ...deps(dataDir),
        allowedOrigins: ['http://localhost:7701'],
        managed: true,
        exit: (c) => exits.push(c),
        lingerMs: 10,
        listen: (f) => {
          fetch = f;
        },
      });
      const res = await (fetch as unknown as (r: Request) => Promise<Response>)(
        new Request('http://localhost:7701/api/v1/system/startup'),
      );
      const status = (await res.json()) as {
        error: { code: string };
        actions: string[];
        restore: { state: string };
      };
      expect(status.error.code).toBe('system.restoring');
      expect(status.actions).toEqual([]);
      expect(status.restore.state).toBe('done');
      await vi.advanceTimersByTimeAsync(20);
      expect(exits).toEqual([RESTART_ALL_EXIT]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the routes while running', () => {
  it('stage, read, apply (asking the desktop app to restart) and drop', async () => {
    const dataDir = tmp();
    putBackup(dataDir, 'ancile-1.dump');
    const exits: number[] = [];
    const r = startupRoutes({ ...deps(dataDir), managed: true, exit: (c) => exits.push(c) });
    const json = { 'content-type': 'application/json', origin: 'http://localhost:7701' };
    expect(
      (
        await r.request('/system/restore/stage', {
          method: 'POST',
          headers: json,
          body: '{"backup":"ancile-1.dump"}',
        })
      ).status,
    ).toBe(201);
    const got = (await (await r.request('/system/restore')).json()) as {
      restore: { state: string };
      managed: boolean;
    };
    expect(got).toMatchObject({ restore: { state: 'staged' }, managed: true });
    const applied = (await (
      await r.request('/system/restore/apply', { method: 'POST', headers: json })
    ).json()) as {
      restarting: boolean;
    };
    expect(applied.restarting).toBe(true);
    expect(exits).toEqual([RESTART_ALL_EXIT]);
    expect((await startupStatus(deps(dataDir), null)).restore?.state).toBe('restarting');
  });
});
