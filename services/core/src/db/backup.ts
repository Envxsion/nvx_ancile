/**
 * ------------------------------------------------------------------
 *  Title    |  Database backups
 *  Ref      |  ROADMAP.md track G · docs/desktop.md (Updates and your data)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  A copy of the whole database before anything changes
 *           |  its shape (every migration, and before an older build
 *           |  is installed), and the way back from one.
 *  How      |  pg_dump --format=custom from the Postgres that pg0
 *           |  installs (~/.pg0/installation/<version>/bin, the same
 *           |  major version as the server), else ANCILE_PG_BIN, else
 *           |  PATH. Written to <data>/backups as a .partial file and
 *           |  renamed when complete, with a .json beside it saying
 *           |  when, why, by which NVX Ancile and at which schema. The
 *           |  newest five before-update backups are kept.
 *           |  Restore: a safety backup of what is there now, then
 *           |  every NVX Ancile schema is dropped and pg_restore puts
 *           |  the backup back in one transaction.
 *  Note     |  The password reaches pg_dump and pg_restore through
 *           |  PGPASSWORD, never the command line, and is never logged.
 * ------------------------------------------------------------------
 */

import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { AncileError } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { type Spawner, spawnProcess } from '../claudecode/cli';
import { logFor } from '../obs/logger';
import { ensureFreeSpace, type StatFs } from '../system/disk';

const log = logFor('backup');

/** How many before-update backups are kept; older ones are removed. */
export const KEEP_BACKUPS = 5;
/** Safety copies (before a restore, before installing an older build) kept. */
export const KEEP_SAFETY = 2;
const DUMP_TIMEOUT_MS = 30 * 60_000;

export type BackupReason = 'before-migration' | 'before-downgrade' | 'before-restore' | 'manual';

export interface BackupInfo {
  /** The file name, which is also its id. */
  name: string;
  path: string;
  created_at: string;
  reason: BackupReason;
  bytes: number;
  /** The NVX Ancile that took it. */
  app_version: string | null;
  /** Core's newest migration at the time (the schema it can be restored into). */
  core_schema: string | null;
  knowledge_revision: string | null;
}

export interface PgTools {
  dump: string;
  restore: string;
  /** Where they were found, for the error when they are not. */
  from: 'ANCILE_PG_BIN' | 'pg0' | 'PATH';
}

export function backupsDir(dataDir: string): string {
  return join(dataDir, 'backups');
}

const exe = (name: string, platform: NodeJS.Platform) => (platform === 'win32' ? `${name}.exe` : name);

/**
 * pg_dump and pg_restore for a server of `major` (pg_dump refuses a newer
 * server). ANCILE_PG_BIN wins; then pg0's own install of the same major
 * version, or the newest one; then whatever is on PATH.
 */
export function findPgTools(
  opts: {
    major?: number | null;
    env?: Record<string, string | undefined>;
    home?: string;
    platform?: NodeJS.Platform;
    exists?: (p: string) => boolean;
    list?: (dir: string) => string[];
  } = {},
): PgTools {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const env = opts.env ?? process.env;
  const pair = (bin: string, from: PgTools['from']): PgTools | null => {
    const dump = join(bin, exe('pg_dump', platform));
    const restore = join(bin, exe('pg_restore', platform));
    return exists(dump) && exists(restore) ? { dump, restore, from } : null;
  };
  if (env.ANCILE_PG_BIN) {
    const found = pair(env.ANCILE_PG_BIN, 'ANCILE_PG_BIN');
    if (found) return found;
  }
  const pg0 = join(opts.home ?? homedir(), '.pg0', 'installation');
  let versions: string[] = [];
  try {
    versions = opts.list ? opts.list(pg0) : exists(pg0) ? readdirSync(pg0) : [];
  } catch {
    versions = [];
  }
  const byNewest = versions.filter((v) => /^\d+(\.\d+)*$/.test(v)).sort((a, b) => compareVersions(b, a));
  const sameMajor = byNewest.filter((v) => opts.major && Number(v.split('.')[0]) === opts.major);
  for (const v of [...sameMajor, ...byNewest]) {
    const found = pair(join(pg0, v, 'bin'), 'pg0');
    if (found) return found;
  }
  return { dump: exe('pg_dump', platform), restore: exe('pg_restore', platform), from: 'PATH' };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** libpq's own variables for a postgres:// URL: the password stays off the command line. */
export function pgEnv(url: string): Record<string, string> {
  const u = new URL(url);
  const env: Record<string, string> = {
    PGHOST: u.hostname.replace(/^\[|\]$/g, '') || '127.0.0.1',
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username || 'postgres'),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '') || 'postgres'),
    PGCONNECT_TIMEOUT: '10',
  };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  return env;
}

export const backupErrors = {
  failed: (why: string, tools?: PgTools) =>
    new AncileError({
      code: 'system.backup_failed',
      title: 'The database could not be backed up',
      hint:
        tools?.from === 'PATH'
          ? 'NVX Ancile could not find pg_dump. Start NVX Ancile again so its database tools are installed, or set ANCILE_PG_BIN to the folder holding pg_dump. Your data was not changed.'
          : 'Your data was not changed. Try again, or continue without a backup if you keep your own copy.',
      status: 503,
      errorClass: 'permanent',
      detail: why.slice(0, 600),
    }),
  restoreFailed: (why: string, safety: string | null) =>
    new AncileError({
      code: 'system.restore_failed',
      title: 'The backup could not be restored',
      hint: safety
        ? `A copy of the database as it was before this restore is in ${safety}. See docs/runbooks/restore-backup.md to put it back by hand.`
        : 'Nothing was changed. See docs/runbooks/restore-backup.md to restore it by hand.',
      status: 500,
      errorClass: 'permanent',
      detail: why.slice(0, 600),
    }),
  unknown: (name: string) =>
    new AncileError({
      code: 'system.backup_not_found',
      title: 'There is no backup by that name',
      hint: 'Pick one from the list of backups.',
      status: 404,
      errorClass: 'permanent',
      detail: name,
    }),
};

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** Every complete backup, newest first. */
export async function listBackups(dataDir: string): Promise<BackupInfo[]> {
  const dir = backupsDir(dataDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names.filter((n) => n.endsWith('.dump'))) {
    const path = join(dir, name);
    let meta: Partial<BackupInfo> = {};
    try {
      meta = JSON.parse(await readFile(`${path}.json`, 'utf8')) as Partial<BackupInfo>;
    } catch {
      /* a backup copied in by hand: what the file itself says is enough */
    }
    try {
      const s = await stat(path);
      out.push({
        name,
        path,
        created_at: meta.created_at ?? s.mtime.toISOString(),
        reason: meta.reason ?? 'manual',
        bytes: s.size,
        app_version: meta.app_version ?? null,
        core_schema: meta.core_schema ?? null,
        knowledge_revision: meta.knowledge_revision ?? null,
      });
    } catch {
      /* removed while listing */
    }
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.name.localeCompare(a.name));
}

/** Keep the newest `keep` before-update backups and `keepSafety` safety copies. */
export async function pruneBackups(
  dataDir: string,
  keep = KEEP_BACKUPS,
  keepSafety = KEEP_SAFETY,
): Promise<string[]> {
  const all = await listBackups(dataDir);
  const update = all.filter((b) => b.reason === 'before-migration');
  const safety = all.filter((b) => b.reason === 'before-restore' || b.reason === 'before-downgrade');
  const drop = [...update.slice(keep), ...safety.slice(keepSafety)];
  for (const b of drop) {
    await rm(b.path, { force: true });
    await rm(`${b.path}.json`, { force: true });
  }
  if (drop.length) log.info({ removed: drop.map((b) => b.name) }, 'removed old database backups');
  return drop.map((b) => b.name);
}

export interface BackupOptions {
  url: string;
  sql: Sql;
  dataDir: string;
  reason: BackupReason;
  appVersion: string;
  coreSchema: string | null;
  knowledgeRevision: string | null;
  tools?: PgTools;
  run?: Spawner;
  now?: () => Date;
  statfs?: StatFs;
}

async function serverMajor(sql: Sql): Promise<number | null> {
  try {
    const [r] = await sql<{ v: string }[]>`select current_setting('server_version_num') as v`;
    return r ? Math.floor(Number(r.v) / 10_000) : null;
  } catch {
    return null;
  }
}

export async function databaseBytes(sql: Sql): Promise<number> {
  const [r] = await sql<{ n: string }[]>`select pg_database_size(current_database())::text as n`;
  return Number(r?.n ?? 0);
}

/** Take a backup now. Checks the disk first; throws system.backup_failed or system.disk_full. */
export async function takeBackup(o: BackupOptions): Promise<BackupInfo> {
  const dir = backupsDir(o.dataDir);
  await mkdir(dir, { recursive: true });
  // A custom-format dump is compressed, so the database's own size is a safe ceiling.
  await ensureFreeSpace(dir, await databaseBytes(o.sql), 'a backup of the database', {
    ...(o.statfs && { statfs: o.statfs }),
  });
  const tools = o.tools ?? findPgTools({ major: await serverMajor(o.sql) });
  const created = (o.now ?? (() => new Date()))();
  const name = `ancile-${stamp(created)}-${o.reason}.dump`;
  const path = join(dir, name);
  const partial = `${path}.partial`;
  const r = await (o.run ?? spawnProcess)(
    tools.dump,
    ['--format=custom', '--compress=6', '--no-password', `--file=${partial}`],
    { timeoutMs: DUMP_TIMEOUT_MS, env: pgEnv(o.url), maxBytes: 16 * 1024 },
  );
  if (r.code !== 0) {
    await rm(partial, { force: true });
    const why = r.timedOut
      ? 'pg_dump took longer than 30 minutes and was stopped.'
      : r.code === 127
        ? `pg_dump could not start (${tools.dump}).`
        : `pg_dump stopped: ${r.stderr.trim().split(/\r?\n/).slice(-3).join(' ')}`;
    log.error({ code: r.code, from: tools.from }, 'database backup failed');
    throw backupErrors.failed(why, r.code === 127 ? tools : undefined);
  }
  await rename(partial, path);
  const info: BackupInfo = {
    name,
    path,
    created_at: created.toISOString(),
    reason: o.reason,
    bytes: (await stat(path)).size,
    app_version: o.appVersion,
    core_schema: o.coreSchema,
    knowledge_revision: o.knowledgeRevision,
  };
  const { path: _p, ...meta } = info;
  await writeFile(`${path}.json`, `${JSON.stringify(meta, null, 2)}\n`);
  log.info({ backup: name, bytes: info.bytes, reason: o.reason }, 'database backed up');
  return info;
}

/** Every schema NVX Ancile's services own (all but Postgres's own and public, where the extensions live). */
async function appSchemas(sql: Sql): Promise<string[]> {
  const rows = await sql<{ nspname: string }[]>`
    select nspname from pg_namespace
    where nspname not like 'pg\_%' and nspname not in ('information_schema', 'public')`;
  return rows.map((r) => r.nspname);
}

export interface RestoreOptions extends Omit<BackupOptions, 'reason'> {
  /** A name from listBackups(). */
  name: string;
}

/**
 * Put a backup back: a safety backup of what is there now, then drop every
 * NVX Ancile schema and restore in one transaction. Other services must be
 * stopped (the desktop app starts only Core while a restore is offered).
 */
export async function restoreBackup(
  o: RestoreOptions,
): Promise<{ restored: BackupInfo; safety: BackupInfo }> {
  const chosen = (await listBackups(o.dataDir)).find((b) => b.name === basename(o.name));
  if (!chosen) throw backupErrors.unknown(o.name);
  const tools = o.tools ?? findPgTools({ major: await serverMajor(o.sql) });
  // What is there now is kept first, so a restore can itself be undone.
  const safety = await takeBackup({ ...o, tools, reason: 'before-restore' });
  try {
    await o.sql.begin(async (tx) => {
      await tx`set local lock_timeout = '15s'`;
      for (const s of await appSchemas(tx as unknown as Sql))
        await tx.unsafe(`drop schema if exists "${s.replace(/"/g, '""')}" cascade`);
    });
  } catch (err) {
    throw backupErrors.restoreFailed(
      `Could not clear the database first (is another NVX Ancile service still running?): ${(err as Error).message}`,
      null,
    );
  }
  const r = await (o.run ?? spawnProcess)(
    tools.restore,
    [
      '--single-transaction',
      '--exit-on-error',
      '--no-password',
      `--dbname=${pgEnv(o.url).PGDATABASE}`,
      chosen.path,
    ],
    { timeoutMs: DUMP_TIMEOUT_MS, env: pgEnv(o.url), maxBytes: 16 * 1024 },
  );
  if (r.code !== 0) {
    log.error({ code: r.code, backup: chosen.name }, 'database restore failed');
    throw backupErrors.restoreFailed(
      r.timedOut
        ? 'pg_restore took longer than 30 minutes.'
        : r.stderr.trim().split(/\r?\n/).slice(-3).join(' '),
      safety.path,
    );
  }
  log.info({ backup: chosen.name, safety: safety.name }, 'database restored from a backup');
  return { restored: chosen, safety };
}

/** Recent enough to stand for "the backup before this update" (the desktop app takes it before Knowledge migrates). */
export async function matchingBackup(
  dataDir: string,
  want: { appVersion: string; coreSchema: string | null },
  now = new Date(),
  withinMs = 6 * 3600_000,
): Promise<BackupInfo | null> {
  for (const b of await listBackups(dataDir)) {
    if (b.reason !== 'before-migration') continue;
    if (now.getTime() - Date.parse(b.created_at) > withinMs) continue;
    if (b.app_version === want.appVersion && b.core_schema === want.coreSchema) return b;
  }
  return null;
}
