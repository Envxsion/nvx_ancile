/**
 * ------------------------------------------------------------------
 *  Title    |  Preparing the database at start
 *  Ref      |  ROADMAP.md track G · docs/desktop.md (Updates and your data)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The one way a database is changed when NVX Ancile
 *           |  starts: never backwards, never without a backup, never
 *           |  onto a full disk.
 *  How      |  1. Read the schema state (db/version.ts). A database a
 *           |     newer NVX Ancile wrote stops here: system.database_newer.
 *           |  2. Nothing to apply, or an empty database: carry on.
 *           |  3. Otherwise back up first (db/backup.ts), unless a backup
 *           |     for this very update was just taken (the desktop app's
 *           |     preflight takes it before Knowledge migrates), or the
 *           |     person chose "Continue without a backup" once.
 *           |  4. Check the disk has room, then apply Core's migrations,
 *           |     each in one transaction (db/migrate.ts).
 *           |  Any failure is an AncileError Core shows on its start-up
 *           |  screen (system/startup.ts) instead of exiting.
 *  Note     |  `preflight` stops after the backup: the desktop app runs
 *           |  it before Knowledge's migrations, so one backup covers
 *           |  every schema.
 * ------------------------------------------------------------------
 */

import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AncileError } from '@nvx/contracts';
import type { Sql } from 'postgres';
import type { Spawner } from '../claudecode/cli';
import { logFor } from '../obs/logger';
import { ensureFreeSpace, type StatFs } from '../system/disk';
import {
  type BackupInfo,
  backupsDir,
  databaseBytes,
  listBackups,
  matchingBackup,
  type PgTools,
  pruneBackups,
  takeBackup,
} from './backup';
import { MIGRATIONS_DIR, migrate } from './migrate';
import { isNewer, needsMigration, type SchemaState, schemaState } from './version';

const log = logFor('db');

/** The marker "Continue without a backup" leaves for the next start; used once. */
export const SKIP_BACKUP_MARKER = '.continue-without-backup';

export function databaseNewer(state: SchemaState, backups: BackupInfo[]): AncileError {
  const by = state.newerBy ? `NVX Ancile ${state.newerBy}` : 'a newer NVX Ancile';
  const before = backups.find((b) => b.reason === 'before-migration' && b.core_schema === state.expected);
  return new AncileError({
    code: 'system.database_newer',
    title: `Your data was updated by ${by}, which this version cannot read`,
    hint: before
      ? `Restore the backup taken before that update (${before.created_at.slice(0, 16).replace('T', ' ')}), or install ${by} again. Nothing has been changed.`
      : `Install ${by} again, or restore a backup from before the update. Nothing has been changed.`,
    status: 409,
    errorClass: 'permanent',
    detail: [
      state.newer.length
        ? `Core schema: ${state.newer.join(', ')} (this version stops at ${state.expected}).`
        : '',
      state.knowledge?.newer
        ? `Knowledge schema: ${state.knowledge.current} is unknown to this version.`
        : '',
      state.controller?.newer.length ? `Controller schema: ${state.controller.newer.join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join(' '),
    context: {
      expected: state.expected,
      newer: state.newer,
      newer_by: state.newerBy,
      knowledge: state.knowledge?.newer ? state.knowledge.current : null,
      restore: before?.name ?? null,
    },
  });
}

export function migrationFailed(name: string, err: unknown): AncileError {
  return new AncileError({
    code: 'system.migration_failed',
    title: 'The database update did not finish, so it was undone',
    hint: 'Your data is as it was before the update. Try again; if it fails again, copy the debug info and report it.',
    status: 500,
    errorClass: 'bug',
    detail: `${name}: ${(err as Error).message}`.slice(0, 600),
    cause: err,
  });
}

export interface PrepareOptions {
  sql: Sql;
  url: string;
  dataDir: string;
  appVersion: string;
  dir?: string;
  knowledgeDir?: string | null;
  controllerDir?: string | null;
  /** Stop after the backup (the desktop app's preflight, before Knowledge migrates). */
  preflight?: boolean;
  tools?: PgTools;
  run?: Spawner;
  statfs?: StatFs;
  now?: () => Date;
  /**
   * Development only (never a release build): start on a database another
   * branch migrated further, without touching what this build does not know.
   */
  allowNewer?: boolean;
}

export interface Prepared {
  state: SchemaState;
  backup: BackupInfo | null;
  /** Why no backup was taken, when none was. */
  skipped: 'nothing_to_do' | 'empty' | 'recent' | 'chosen' | null;
  applied: string[];
}

export async function prepareDatabase(o: PrepareOptions): Promise<Prepared> {
  const dir = o.dir ?? MIGRATIONS_DIR;
  const state = await schemaState(o.sql, {
    dir,
    knowledgeDir: o.knowledgeDir ?? null,
    controllerDir: o.controllerDir ?? null,
  });
  if (isNewer(state)) {
    if (!o.allowNewer) throw databaseNewer(state, await listBackups(o.dataDir));
    // Development only: another branch migrated this database further. Nothing runs backwards.
    log.warn(
      { newer: state.newer, knowledge: state.knowledge?.current ?? null },
      'the database is newer than this checkout; carrying on because ANCILE_ALLOW_NEWER_DATABASE is set',
    );
  }

  let backup: BackupInfo | null = null;
  let skipped: Prepared['skipped'] = null;
  if (!needsMigration(state)) skipped = 'nothing_to_do';
  else if (state.empty) skipped = 'empty';
  else {
    const marker = join(backupsDir(o.dataDir), SKIP_BACKUP_MARKER);
    const recent = await matchingBackup(o.dataDir, { appVersion: o.appVersion, coreSchema: state.current });
    if (recent) {
      backup = recent;
      skipped = 'recent';
    } else if (existsSync(marker)) {
      await rm(marker, { force: true });
      skipped = 'chosen';
      log.warn({}, 'updating the database without a backup, as chosen on the start-up screen');
    } else {
      backup = await takeBackup({
        url: o.url,
        sql: o.sql,
        dataDir: o.dataDir,
        reason: 'before-migration',
        appVersion: o.appVersion,
        coreSchema: state.current,
        knowledgeRevision: state.knowledge?.current ?? null,
        ...(o.tools && { tools: o.tools }),
        ...(o.run && { run: o.run }),
        ...(o.statfs && { statfs: o.statfs }),
        ...(o.now && { now: o.now }),
      });
      await pruneBackups(o.dataDir).catch((err: unknown) =>
        log.warn({ err }, 'could not remove old database backups'),
      );
    }
  }
  if (o.preflight || state.pending.length === 0) return { state, backup, skipped, applied: [] };

  // A migration may rewrite a table: room for a quarter of the database, at least 200 MB.
  await ensureFreeSpace(
    o.dataDir,
    Math.max(200 * 1024 * 1024, (await databaseBytes(o.sql)) / 4),
    'updating the database',
    { ...(o.statfs && { statfs: o.statfs }) },
  );
  const applied: string[] = [];
  for (const name of state.pending) {
    try {
      // One at a time so the error names the file; each is its own transaction.
      applied.push(...(await migrate(o.sql, dir, { appVersion: o.appVersion, only: name })));
    } catch (err) {
      throw migrationFailed(name, err);
    }
  }
  return { state, backup, skipped, applied };
}

/** "Continue without a backup": the next start updates the database without one, once. */
export async function chooseNoBackup(dataDir: string): Promise<void> {
  const dir = backupsDir(dataDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, SKIP_BACKUP_MARKER), new Date().toISOString());
}
