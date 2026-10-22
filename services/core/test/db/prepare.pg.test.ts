/**
 * Starting on a real database (needs CORE_TEST_DATABASE_URL; each run gets
 * a throwaway database): never backwards, never without a backup, never
 * onto a full disk, each migration all or nothing, and a backup that comes
 * back through the start-up screen.
 */
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Spawner } from '../../src/claudecode/cli';
import { backupsDir, findPgTools, listBackups } from '../../src/db/backup';
import { MIGRATIONS_DIR, migrate, migrationFiles } from '../../src/db/migrate';
import { chooseNoBackup, prepareDatabase, SKIP_BACKUP_MARKER } from '../../src/db/prepare';
import { schemaState } from '../../src/db/version';
import { RESTART_ALL_EXIT, stoppedApp } from '../../src/system/startup';
import { BROWSER, COCKPIT_ORIGIN, headersFor, SCRIPT, testLocalAuth } from '../support/local';
import { type Throwaway, throwawayDb } from '../support/throwaway-db';

const base = inject('pgUrl');
const roomy = async () => ({ bavail: 1e9, bsize: 4096 });
const fakeDump: Spawner = async (_cmd, args) => {
  const file = args.find((a) => a.startsWith('--file='))?.slice(7);
  if (file) writeFileSync(file, 'PGDMP fake');
  return { code: 0, stdout: '', stderr: '', timedOut: false };
};
const fakeTools = { dump: 'pg_dump', restore: 'pg_restore', from: 'pg0' as const };

describe.skipIf(!base)('preparing the database at start (postgres)', () => {
  let db: Throwaway;
  let dataDir: string;
  let shipped: string[];
  const temps: string[] = [];

  /** This build's migrations plus `extra` files, as a newer build would carry them. */
  const withExtra = (extra: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'ancile-mig-'));
    temps.push(dir);
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    for (const [name, body] of Object.entries(extra)) writeFileSync(join(dir, name), body);
    return dir;
  };
  const tableExists = async (name: string) =>
    (await db.sql<{ t: string | null }[]>`select to_regclass(${name})::text as t`)[0]?.t !== null;
  const ledger = async () =>
    (await db.sql<{ name: string }[]>`select name from core._migrations order by name`).map((r) => r.name);

  beforeAll(async () => {
    db = await throwawayDb(base as string, 'ancile_coretest_prepare');
    shipped = await migrationFiles();
  });
  afterAll(async () => {
    await db?.drop();
    for (const d of temps) rmSync(d, { recursive: true, force: true });
  });
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ancile-data-'));
    temps.push(dataDir);
  });

  const prepare = (o: Partial<Parameters<typeof prepareDatabase>[0]> = {}) =>
    prepareDatabase({
      sql: db.sql,
      url: db.url,
      dataDir,
      appVersion: '0.2.0',
      knowledgeDir: null,
      tools: fakeTools,
      run: fakeDump,
      statfs: roomy,
      ...o,
    });

  it('migrates an empty database without a backup, recording which NVX Ancile did it', async () => {
    const r = await prepare();
    expect(r.skipped).toBe('empty');
    expect(r.applied).toEqual(shipped);
    expect(await listBackups(dataDir)).toEqual([]);
    const [row] = await db.sql<{ app_version: string }[]>`
      select app_version from core._migrations order by name desc limit 1`;
    expect(row?.app_version).toBe('0.2.0');
    expect((await prepare()).skipped).toBe('nothing_to_do');
  });

  it('backs up before an update, then applies it', async () => {
    const dir = withExtra({ '9000_extra.sql': 'create table core.t_extra (id int);' });
    const r = await prepare({ dir, appVersion: '0.3.0' });
    expect(r.backup?.reason).toBe('before-migration');
    expect(r.backup?.core_schema).toBe(shipped.at(-1));
    expect(r.applied).toEqual(['9000_extra.sql']);
    expect(await tableExists('core.t_extra')).toBe(true);
    // The desktop preflight's backup stands for Core's own start.
    await db.sql`delete from core._migrations where name = '9000_extra.sql'`;
    await db.sql`drop table core.t_extra`;
  });

  it('a backup taken by the preflight is not taken twice', async () => {
    const dir = withExtra({ '9001_more.sql': 'create table core.t_more (id int);' });
    const first = await prepare({ dir, preflight: true, appVersion: '0.4.0' });
    expect(first.backup).not.toBeNull();
    expect(first.applied).toEqual([]);
    expect(await tableExists('core.t_more')).toBe(false);
    const second = await prepare({ dir, appVersion: '0.4.0' });
    expect(second.skipped).toBe('recent');
    expect(second.applied).toEqual(['9001_more.sql']);
    expect((await listBackups(dataDir)).length).toBe(1);
    await db.sql`delete from core._migrations where name = '9001_more.sql'`;
    await db.sql`drop table core.t_more`;
  });

  it('changes nothing when the backup fails', async () => {
    const dir = withExtra({ '9002_never.sql': 'create table core.t_never (id int);' });
    const failing: Spawner = async () => ({
      code: 1,
      stdout: '',
      stderr: 'pg_dump: error: boom',
      timedOut: false,
    });
    await expect(prepare({ dir, run: failing })).rejects.toMatchObject({ code: 'system.backup_failed' });
    expect(await tableExists('core.t_never')).toBe(false);
    expect(await ledger()).not.toContain('9002_never.sql');
  });

  it('updates once without a backup when the person chose that', async () => {
    const dir = withExtra({ '9003_chosen.sql': 'create table core.t_chosen (id int);' });
    await chooseNoBackup(dataDir);
    const failing: Spawner = async () => ({ code: 1, stdout: '', stderr: 'never called', timedOut: false });
    const r = await prepare({ dir, run: failing });
    expect(r.skipped).toBe('chosen');
    expect(existsSync(join(backupsDir(dataDir), SKIP_BACKUP_MARKER))).toBe(false);
    expect(await tableExists('core.t_chosen')).toBe(true);
    await db.sql`delete from core._migrations where name = '9003_chosen.sql'`;
    await db.sql`drop table core.t_chosen`;
  });

  it('changes nothing on a full disk', async () => {
    const dir = withExtra({ '9004_full.sql': 'create table core.t_full (id int);' });
    const tiny = async () => ({ bavail: 10, bsize: 4096 });
    await expect(prepare({ dir, statfs: tiny })).rejects.toMatchObject({ code: 'system.disk_full' });
    expect(await tableExists('core.t_full')).toBe(false);
    expect(await listBackups(dataDir)).toEqual([]);
  });

  it('undoes a migration that fails half way: one transaction per file', async () => {
    const dir = withExtra({
      '9005_half.sql': 'create table core.t_half (id int);\ninsert into core.t_half values (1);\nselect 1/0;',
    });
    const err = await prepare({ dir }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'system.migration_failed' });
    expect((err as { detail: string }).detail).toContain('9005_half.sql');
    expect(await tableExists('core.t_half')).toBe(false);
    expect(await ledger()).not.toContain('9005_half.sql');
  });

  it('refuses a database a newer NVX Ancile wrote, and never runs anything backwards', async () => {
    await db.sql`insert into core._migrations (name, app_version) values ('9999_future.sql', '0.9.0')`;
    const before = await ledger();
    const err = await prepare().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'system.database_newer', status: 409 });
    expect((err as { title: string }).title).toContain('NVX Ancile 0.9.0');
    expect(await ledger()).toEqual(before);
    const s = await schemaState(db.sql);
    expect(s.newer).toEqual(['9999_future.sql']);
    expect(s.expected).toBe(shipped.at(-1));
    // A development checkout may carry on (another branch migrated further); still nothing backwards.
    expect((await prepare({ allowNewer: true })).applied).toEqual([]);
    expect(await ledger()).toEqual(before);
    await db.sql`delete from core._migrations where name = '9999_future.sql'`;
  });

  it('refuses a Knowledge schema this build does not know', async () => {
    const kdir = mkdtempSync(join(tmpdir(), 'ancile-alembic-'));
    temps.push(kdir);
    writeFileSync(join(kdir, '0001_init.py'), 'revision = "0001_init"\ndown_revision = None\n');
    await db.sql`create table if not exists knowledge.alembic_version (version_num varchar(32) primary key)`;
    await db.sql`delete from knowledge.alembic_version`;
    await db.sql`insert into knowledge.alembic_version values ('0007_future')`;
    await expect(prepare({ knowledgeDir: kdir })).rejects.toMatchObject({ code: 'system.database_newer' });
    await db.sql`update knowledge.alembic_version set version_num = '0001_init'`;
    expect((await prepare({ knowledgeDir: kdir })).skipped).toBe('nothing_to_do');
  });

  it("backs up before the Controller's migrations, and refuses a Controller schema it does not know", async () => {
    const cdir = mkdtempSync(join(tmpdir(), 'ancile-ctl-'));
    temps.push(cdir);
    writeFileSync(join(cdir, '0000_init.sql'), 'select 1;');
    writeFileSync(join(cdir, '0001_more.sql'), 'select 1;');
    // A Controller that never ran here (it may use a database of its own): nothing to back up.
    expect((await schemaState(db.sql, { controllerDir: cdir })).controller).toBeNull();
    await db.sql`create table if not exists controller._migrations (name text primary key, applied_at timestamptz not null default now())`;
    await db.sql`insert into controller._migrations (name) values ('0000_init.sql')`;
    const pending = await prepare({ controllerDir: cdir });
    expect(pending.state.controller).toEqual({ pending: ['0001_more.sql'], newer: [] });
    expect(pending.backup?.reason).toBe('before-migration');
    await db.sql`insert into controller._migrations (name) values ('0001_more.sql'), ('0099_future.sql')`;
    const err = await prepare({ controllerDir: cdir }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'system.database_newer' });
    expect((err as { detail: string }).detail).toContain('Controller schema: 0099_future.sql');
    await db.sql`drop table controller._migrations`;
  });

  const realTools = findPgTools({ major: 18 });
  it.skipIf(realTools.from === 'PATH')(
    'restores the backup taken before an update from the start-up screen (real pg_dump and pg_restore)',
    async () => {
      // A newer build updates the database, backing it up first.
      const dir = withExtra({
        '9006_newer.sql': 'create table core.t_newer (id int); insert into core.t_newer values (7);',
      });
      const up = await prepareDatabase({
        sql: db.sql,
        url: db.url,
        dataDir,
        appVersion: '0.5.0',
        dir,
        knowledgeDir: null,
      });
      expect(up.backup?.bytes).toBeGreaterThan(0);
      expect(await tableExists('core.t_newer')).toBe(true);

      // This (older) build starts on it: stopped, with the backup offered.
      const err = await prepareDatabase({
        sql: db.sql,
        url: db.url,
        dataDir,
        appVersion: '0.2.0',
        knowledgeDir: null,
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'system.database_newer' });
      const exits: number[] = [];
      const localAuth = testLocalAuth();
      const key = headersFor(localAuth, SCRIPT);
      const app = stoppedApp({
        error: err as never,
        sql: db.sql,
        url: db.url,
        dataDir,
        version: '0.2.0',
        schema: () => ({ expected: shipped.at(-1) ?? '', current: '9006_newer.sql' }),
        allowedOrigins: [COCKPIT_ORIGIN],
        localAuth,
        managed: true,
        exit: (code) => exits.push(code),
      });
      const status = (await (await app.request('/api/v1/system/startup', { headers: key })).json()) as {
        state: string;
        actions: string[];
        suggested: string | null;
      };
      expect(status.state).toBe('stopped');
      expect(status.actions).toEqual(['restore', 'reinstall']);
      expect(status.suggested).toBe(up.backup?.name);

      // Restoring replaces the database, so a script with the key alone is refused; the start-up screen is a browser.
      const body = JSON.stringify({ backup: status.suggested });
      const refused = await app.request('/api/v1/system/startup/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...key },
        body,
      });
      expect(refused.status).toBe(403);
      expect(exits).toEqual([]);
      const res = await app.request('/api/v1/system/startup/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headersFor(localAuth, BROWSER) },
        body,
      });
      expect(res.status).toBe(200);
      expect(exits).toEqual([RESTART_ALL_EXIT]);
      // Back as it was before the update; what was there is kept as a safety copy.
      expect(await tableExists('core.t_newer')).toBe(false);
      expect(await ledger()).not.toContain('9006_newer.sql');
      expect((await listBackups(dataDir)).some((b) => b.reason === 'before-restore')).toBe(true);
      expect(
        (
          await prepareDatabase({
            sql: db.sql,
            url: db.url,
            dataDir,
            appVersion: '0.2.0',
            knowledgeDir: null,
          })
        ).skipped,
      ).toBe('nothing_to_do');
      // The owner and the rest of the data came back with it.
      expect((await migrate(db.sql)).length).toBe(0);
    },
    60_000,
  );
});
