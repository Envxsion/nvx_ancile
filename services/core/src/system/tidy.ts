/**
 * ------------------------------------------------------------------
 *  Title    |  Tidy storage
 *  Ref      |  ROADMAP.md MT1 · docs/storage.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Give back the space that pile-up wastes: duplicate
 *           |  chunks and identical old version bodies (the knowledge
 *           |  service does the work, by content hash), then VACUUM.
 *           |  A button in Admin → Diagnostics, and the built-in
 *           |  automation "Tidy storage".
 *  How      |  In this order, stopping at the first thing that is not
 *           |  right and changing nothing: no run is active (and, for
 *           |  the automation, none for a few minutes); enough free
 *           |  disk for a backup; a database backup (kept: the newest
 *           |  two); no run started meanwhile; the knowledge service
 *           |  tidies; VACUUM (ANALYZE). A dry run checks the same
 *           |  things and only counts.
 *  Note     |  Never during a run: a run reads chunks and writes
 *           |  history. Core does not hold new runs back while this
 *           |  goes (it is minutes at most, and what it removes is not
 *           |  read by any run), so the second check after the backup
 *           |  is the last word. Idea from Octop (MIT); the code is ours.
 * ------------------------------------------------------------------
 */

import { AncileError, system } from '@nvx/contracts';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import type { AppEnv } from '../app';
import { databaseBytes, pruneBackups } from '../db/backup';
import { body } from '../http/body';
import type { KnowledgeClient } from '../knowledge/client';
import { logFor } from '../obs/logger';
import { ensureFreeSpace, formatBytes, type StatFs } from './disk';

const log = logFor('tidy');

/** The automation waits for this long without a run before it starts. */
export const IDLE_MINUTES = 10;

/** Room kept beyond the backup's size for the tidy itself (it frees space; it never needs much). */
const TIDY_ROOM = 64 * 1024 * 1024;

const TIMEOUT_MS = 20 * 60_000;

export interface TidyDeps {
  sql: Sql;
  dataDir: string;
  kn?: Pick<KnowledgeClient, 'post'> | undefined;
  /** Runs that are queued, running or waiting. */
  activeRuns: () => Promise<number>;
  /** When a run last started or finished, or null if none ever did. */
  lastRunActivity: () => Promise<Date | null>;
  /** A database backup, taken before anything changes. */
  backup: () => Promise<{ name: string }>;
  now?: () => Date;
  statfs?: StatFs;
  /** Overridable for tests. */
  vacuum?: () => Promise<void>;
}

export interface TidyOptions {
  dryRun?: boolean;
  /** Wait until no run has started or finished for this many minutes (0: only refuse while one is active). */
  idleMinutes?: number;
}

const busy = (title: string, hint: string) =>
  new AncileError({
    code: 'maintenance.busy',
    title,
    hint,
    status: 409,
    errorClass: 'transient',
    retryable: true,
  });

const SUMMARY = (r: Omit<system.TidyReport, 'summary'>): string => {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const found =
    r.chunks_removed === 0 && r.bodies_linked === 0
      ? 'Nothing was duplicated, so nothing was removed'
      : `${r.dry_run ? 'Would remove' : 'Removed'} ${n(r.chunks_removed, 'duplicate chunk', 'duplicate chunks')}${
          r.parents_removed ? ` and ${n(r.parents_removed, 'empty parent', 'empty parents')}` : ''
        }; ${r.dry_run ? 'would share' : 'shared'} ${n(r.bodies_linked, 'identical old version', 'identical old versions')}${
          r.bytes_freed ? ` (${formatBytes(r.bytes_freed)} ${r.dry_run ? 'to give back' : 'given back'})` : ''
        }`;
  return `${found}.${r.vacuumed ? ' The database was vacuumed.' : ''}${r.backup ? ` A backup was taken first (${r.backup}).` : ''}`;
};

/** Tidy storage. Throws maintenance.busy, system.disk_full or system.backup_failed with nothing changed. */
export async function tidyStorage(deps: TidyDeps, opts: TidyOptions = {}): Promise<system.TidyReport> {
  const dryRun = opts.dryRun === true;
  const now = (deps.now ?? (() => new Date()))();

  const active = await deps.activeRuns();
  if (active > 0)
    throw busy(
      "Storage can't be tidied while something is running",
      `${active === 1 ? 'A run is' : `${active} runs are`} in progress. Wait until ${active === 1 ? 'it finishes' : 'they finish'}, or stop ${active === 1 ? 'it' : 'them'}, then try again. Nothing was changed.`,
    );
  const idle = opts.idleMinutes ?? 0;
  if (idle > 0) {
    const last = await deps.lastRunActivity();
    if (last && now.getTime() - last.getTime() < idle * 60_000)
      throw busy(
        'NVX Ancile was used a moment ago',
        `Storage is tidied after ${idle} quiet minutes. It will try again at the next scheduled time. Nothing was changed.`,
      );
  }

  let backupName: string | null = null;
  if (!dryRun) {
    // A backup is at most the database's size (it is compressed); then room to work.
    await ensureFreeSpace(deps.dataDir, (await databaseBytes(deps.sql)) + TIDY_ROOM, 'tidying storage', {
      ...(deps.statfs && { statfs: deps.statfs }),
    });
    backupName = (await deps.backup()).name;
    await pruneBackups(deps.dataDir).catch((err: unknown) =>
      log.warn({ err }, 'could not remove old backups after a tidy backup'),
    );
    // A backup can take minutes: look again before changing anything.
    if ((await deps.activeRuns()) > 0)
      throw busy(
        'A run started while the backup was being taken',
        'Nothing was changed. The backup is kept. Try again when nothing is running.',
      );
  }

  let found: {
    chunks_removed?: number;
    parents_removed?: number;
    bodies_linked?: number;
    bodies_bytes?: number;
  } = {};
  if (deps.kn)
    found = await deps.kn.post('/maintenance/tidy', { dry_run: dryRun }, { timeoutMs: TIMEOUT_MS });

  let vacuumed = false;
  if (!dryRun) {
    // VACUUM cannot run inside a transaction; the pool hands it a plain connection.
    await (deps.vacuum ?? (async () => void (await deps.sql.unsafe('VACUUM (ANALYZE)'))))();
    vacuumed = true;
  }

  const base = {
    dry_run: dryRun,
    backup: backupName,
    chunks_removed: found.chunks_removed ?? 0,
    parents_removed: found.parents_removed ?? 0,
    bodies_linked: found.bodies_linked ?? 0,
    bytes_freed: found.bodies_bytes ?? 0,
    vacuumed,
  };
  const report = { ...base, summary: SUMMARY(base) };
  log.info({ ...base }, dryRun ? 'storage tidy previewed' : 'storage tidied');
  return report;
}

/** POST /api/v1/system/tidy {dry_run}: Admin → Diagnostics → Tidy storage. */
export function tidyRoutes(deps: TidyDeps) {
  const r = new Hono<AppEnv>();
  r.post('/system/tidy', async (c) => {
    const req = await body(c, system.TidyRequest);
    return c.json(await tidyStorage(deps, { dryRun: req.dry_run }));
  });
  return r;
}
