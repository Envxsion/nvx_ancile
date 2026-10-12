/**
 * Database backups without a database: which pg_dump is used, how the
 * password travels, how backups are named, kept and pruned, and that a
 * failed or impossible backup says so before anything changes.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import type { Spawner } from '../../src/claudecode/cli';
import {
  backupsDir,
  findPgTools,
  listBackups,
  matchingBackup,
  pgEnv,
  pruneBackups,
  takeBackup,
} from '../../src/db/backup';
import { assertTransactional, MIGRATIONS_DIR, migrationFiles } from '../../src/db/migrate';
import { alembicRevisions } from '../../src/db/version';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ancile-backup-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A tagged-template stand-in: the only query takeBackup makes is the database's size. */
const fakeSql = ((..._: unknown[]) =>
  Promise.resolve([{ n: String(10 * 1024 * 1024), v: '180001' }])) as unknown as Sql;
const roomy = async () => ({ bavail: 1e9, bsize: 4096 });
const tools = { dump: 'pg_dump', restore: 'pg_restore', from: 'pg0' as const };

/** pg_dump that writes a file where --file= says, and remembers how it was called. */
function fakeDump(calls: { cmd: string; args: string[]; env?: Record<string, string> }[]): Spawner {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args, ...(opts.env && { env: opts.env }) });
    const file = args.find((a) => a.startsWith('--file='))?.slice(7);
    if (file) writeFileSync(file, 'PGDMP fake');
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  };
}

describe('pg_dump and pg_restore', () => {
  const have = (paths: string[]) => (p: string) => paths.includes(p);

  it("prefer ANCILE_PG_BIN, then pg0's install of the server's major version, then PATH", () => {
    const home = join('/', 'home', 'ana');
    const pg0 = join(home, '.pg0', 'installation');
    const bin = (v: string) => join(pg0, v, 'bin');
    const both = (b: string) => [join(b, 'pg_dump'), join(b, 'pg_restore')];
    const list = () => ['17.4.0', '18.1.0', 'tmp'];
    expect(
      findPgTools({
        major: 17,
        home,
        platform: 'linux',
        list,
        exists: have([...both(bin('17.4.0')), ...both(bin('18.1.0'))]),
      }),
    ).toEqual({
      dump: join(bin('17.4.0'), 'pg_dump'),
      restore: join(bin('17.4.0'), 'pg_restore'),
      from: 'pg0',
    });
    // No exact match: the newest.
    expect(
      findPgTools({ major: 16, home, platform: 'linux', list, exists: have(both(bin('18.1.0'))) }).dump,
    ).toBe(join(bin('18.1.0'), 'pg_dump'));
    expect(
      findPgTools({
        major: 18,
        home,
        platform: 'linux',
        list,
        env: { ANCILE_PG_BIN: '/opt/pg/bin' },
        exists: have([...both('/opt/pg/bin'), ...both(bin('18.1.0'))]),
      }).from,
    ).toBe('ANCILE_PG_BIN');
    expect(findPgTools({ home, platform: 'win32', list: () => [], exists: () => false })).toEqual({
      dump: 'pg_dump.exe',
      restore: 'pg_restore.exe',
      from: 'PATH',
    });
  });

  it('get the connection from libpq variables, never the command line', () => {
    expect(pgEnv('postgres://ancile:p%40ss%2Fw0rd@127.0.0.1:5433/ancile')).toEqual({
      PGHOST: '127.0.0.1',
      PGPORT: '5433',
      PGUSER: 'ancile',
      PGDATABASE: 'ancile',
      PGPASSWORD: 'p@ss/w0rd',
      PGCONNECT_TIMEOUT: '10',
    });
  });
});

describe('taking a backup', () => {
  it('writes a complete dump with what it was taken for, and keeps the password off the command line', async () => {
    const dataDir = tmp();
    const calls: Parameters<typeof fakeDump>[0] = [];
    const b = await takeBackup({
      url: 'postgres://ancile:secret@127.0.0.1:5433/ancile',
      sql: fakeSql,
      dataDir,
      reason: 'before-migration',
      appVersion: '0.2.0',
      coreSchema: '0020_claude_code_fork_lookup.sql',
      knowledgeRevision: '0002_ingest',
      tools,
      run: fakeDump(calls),
      statfs: roomy,
      now: () => new Date('2026-10-12T09:30:05Z'),
    });
    expect(b.name).toBe('ancile-20261012-093005-before-migration.dump');
    expect(existsSync(b.path)).toBe(true);
    expect(existsSync(`${b.path}.partial`)).toBe(false);
    expect(JSON.parse(readFileSync(`${b.path}.json`, 'utf8'))).toMatchObject({
      reason: 'before-migration',
      app_version: '0.2.0',
      core_schema: '0020_claude_code_fork_lookup.sql',
      knowledge_revision: '0002_ingest',
    });
    expect(calls[0]?.args.join(' ')).not.toContain('secret');
    expect(calls[0]?.env?.PGPASSWORD).toBe('secret');
    expect((await listBackups(dataDir)).map((x) => x.name)).toEqual([b.name]);
  });

  it('says why when pg_dump fails, and leaves no half-written file', async () => {
    const dataDir = tmp();
    const run: Spawner = async (_c, args) => {
      const file = args.find((a) => a.startsWith('--file='))?.slice(7);
      if (file) writeFileSync(file, 'half');
      return { code: 1, stdout: '', stderr: 'pg_dump: error: connection to server failed', timedOut: false };
    };
    const err = await takeBackup({
      url: 'postgres://a:b@127.0.0.1:5433/ancile',
      sql: fakeSql,
      dataDir,
      reason: 'before-migration',
      appVersion: '0.2.0',
      coreSchema: null,
      knowledgeRevision: null,
      tools,
      run,
      statfs: roomy,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'system.backup_failed', title: 'The database could not be backed up' });
    expect((err as { detail: string }).detail).toContain('connection to server failed');
    expect(await listBackups(dataDir)).toEqual([]);
  });

  it('checks the disk before it starts', async () => {
    const calls: Parameters<typeof fakeDump>[0] = [];
    await expect(
      takeBackup({
        url: 'postgres://a:b@127.0.0.1:5433/ancile',
        sql: fakeSql,
        dataDir: tmp(),
        reason: 'before-migration',
        appVersion: '0.2.0',
        coreSchema: null,
        knowledgeRevision: null,
        tools,
        run: fakeDump(calls),
        statfs: async () => ({ bavail: 1, bsize: 4096 }),
      }),
    ).rejects.toMatchObject({ code: 'system.disk_full' });
    expect(calls).toEqual([]);
  });

  it('names a missing pg_dump and how to point at one', async () => {
    const err = await takeBackup({
      url: 'postgres://a:b@127.0.0.1:5433/ancile',
      sql: fakeSql,
      dataDir: tmp(),
      reason: 'before-migration',
      appVersion: '0.2.0',
      coreSchema: null,
      knowledgeRevision: null,
      tools: { ...tools, from: 'PATH' },
      run: async () => ({ code: 127, stdout: '', stderr: 'spawn pg_dump ENOENT', timedOut: false }),
      statfs: roomy,
    }).catch((e: unknown) => e);
    expect((err as { hint: string }).hint).toContain('ANCILE_PG_BIN');
  });
});

describe('keeping backups', () => {
  const put = (dataDir: string, name: string, reason: string, at: string, extra: object = {}) => {
    const dir = backupsDir(dataDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), 'x');
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ reason, created_at: at, ...extra }));
  };

  it('keeps the newest five before-update backups and two safety copies', async () => {
    const dataDir = tmp();
    for (let i = 1; i <= 7; i++) put(dataDir, `m${i}.dump`, 'before-migration', `2026-10-0${i}T00:00:00Z`);
    for (let i = 1; i <= 3; i++) put(dataDir, `r${i}.dump`, 'before-restore', `2026-10-0${i}T01:00:00Z`);
    put(dataDir, 'mine.dump', 'manual', '2026-01-01T00:00:00Z');
    const removed = await pruneBackups(dataDir);
    expect(removed.sort()).toEqual(['m1.dump', 'm2.dump', 'r1.dump']);
    const left = (await listBackups(dataDir)).map((b) => b.name);
    expect(left).toContain('mine.dump');
    expect(left.filter((n) => n.startsWith('m')).length).toBe(6);
  });

  it('finds the backup the desktop app took before this very update', async () => {
    const dataDir = tmp();
    const now = new Date('2026-10-12T10:00:00Z');
    put(dataDir, 'a.dump', 'before-migration', '2026-10-12T09:59:00Z', {
      app_version: '0.3.0',
      core_schema: '0020.sql',
    });
    expect(await matchingBackup(dataDir, { appVersion: '0.3.0', coreSchema: '0020.sql' }, now)).toMatchObject(
      { name: 'a.dump' },
    );
    expect(await matchingBackup(dataDir, { appVersion: '0.3.1', coreSchema: '0020.sql' }, now)).toBeNull();
    expect(
      await matchingBackup(
        dataDir,
        { appVersion: '0.3.0', coreSchema: '0020.sql' },
        new Date('2026-10-13T10:00:00Z'),
      ),
    ).toBeNull();
  });
});

describe('migrations', () => {
  it('each shipped migration can run inside one transaction', async () => {
    for (const f of await migrationFiles())
      expect(() => assertTransactional(f, readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))).not.toThrow();
  });

  it('refuse a file that would end or escape its transaction', () => {
    expect(() => assertTransactional('x.sql', 'create table a(); commit;')).toThrow(/x.sql/);
    expect(() => assertTransactional('x.sql', 'create index concurrently i on a(b);')).toThrow();
    expect(() => assertTransactional('x.sql', 'BEGIN;\ncreate table a();')).toThrow();
    // plpgsql bodies say BEGIN and END legitimately.
    expect(() =>
      assertTransactional(
        'x.sql',
        'create function f() returns int language plpgsql as $$ begin return 1; end; $$;\n-- commit; in a comment',
      ),
    ).not.toThrow();
  });

  it("read Knowledge's Alembic revisions and its head", async () => {
    const dir = tmp();
    writeFileSync(join(dir, '0001_init.py'), 'revision = "0001_init"\ndown_revision = None\n');
    writeFileSync(
      join(dir, '0002_more.py'),
      'revision: str = "0002_more"\ndown_revision: str | None = "0001_init"\n',
    );
    expect(await alembicRevisions(dir)).toEqual({ revisions: ['0001_init', '0002_more'], head: '0002_more' });
  });
});
