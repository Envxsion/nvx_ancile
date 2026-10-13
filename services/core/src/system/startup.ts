/**
 * ------------------------------------------------------------------
 *  Title    |  Start-up screen and backups
 *  Ref      |  ROADMAP.md track G · docs/desktop.md (Updates and your data)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  When Core cannot safely open the database (it is newer
 *           |  than this build, the backup before an update failed,
 *           |  the disk is full, an update failed and was undone) it
 *           |  does not exit and leave a blank window: it serves the
 *           |  Cockpit, which shows what happened and what can be done.
 *  How      |  stoppedApp(): /health and /ready answer (so the desktop
 *           |  app opens the window), GET /api/v1/system/startup says
 *           |  why, and three actions: restore a backup, try again,
 *           |  continue without a backup (only after a failed backup).
 *           |  Every other /api route answers with the same error.
 *           |  After a restore or a retry the desktop app is asked to
 *           |  start every service again (exit code 75); elsewhere the
 *           |  screen asks the person to restart NVX Ancile.
 *           |  startupRoutes(): the same status while running, the
 *           |  list of backups, and "Back up now"; the desktop app asks
 *           |  for a backup before it installs an older build.
 *  Note     |  A backup is chosen by name from the list, never a path.
 * ------------------------------------------------------------------
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { AncileError, system } from '@nvx/contracts';
import { type Context, Hono } from 'hono';
import type { Sql } from 'postgres';
import type { AppEnv } from '../app';
import {
  type BackupInfo,
  backupsDir,
  listBackups,
  type PgTools,
  restoreBackup,
  takeBackup,
} from '../db/backup';
import { chooseNoBackup } from '../db/prepare';
import type { SchemaState } from '../db/version';
import { body } from '../http/body';
import { cockpitPageHeaders } from '../http/csp';
import { requestGuard } from '../http/guard';
import { errorHandler } from '../obs/errors';
import { logFor } from '../obs/logger';
import { traceMiddleware } from '../obs/tracing';

const log = logFor('startup');

/** Exit code that asks the desktop app to start every service again (EX_TEMPFAIL). */
export const RESTART_ALL_EXIT = 75;

export const publicBackup = (b: BackupInfo): system.Backup => {
  const { path: _p, ...rest } = b;
  return rest;
};

export interface StartupDeps {
  sql: Sql;
  url: string;
  dataDir: string;
  version: string;
  schema: () => Pick<SchemaState, 'expected' | 'current'>;
  tools?: PgTools;
}

/** Which actions fit an error. */
export function actionsFor(code: string | null, hasBackups: boolean): system.StartupAction[] {
  switch (code) {
    case 'system.database_newer':
      return [...(hasBackups ? (['restore'] as const) : []), 'reinstall'];
    case 'system.backup_failed':
      return ['retry', 'continue_without_backup'];
    case 'system.disk_full':
    case 'system.migration_failed':
      return ['retry', ...(hasBackups ? (['restore'] as const) : [])];
    case null:
      return [];
    default:
      return ['retry'];
  }
}

export async function startupStatus(
  deps: Pick<StartupDeps, 'dataDir' | 'version' | 'schema'>,
  error: AncileError | null,
  traceId = '0'.repeat(32),
): Promise<system.StartupStatus> {
  const backups = await listBackups(deps.dataDir);
  const suggested =
    (error?.context.restore as string | null | undefined) ??
    (error?.code === 'system.migration_failed' || error?.code === 'system.disk_full'
      ? (backups.find((b) => b.reason === 'before-migration')?.name ?? null)
      : null);
  const s = deps.schema();
  return {
    state: error ? 'stopped' : 'running',
    version: deps.version,
    schema: { expected: s.expected, current: s.current },
    error: error ? error.toJSON(traceId).error : null,
    actions: actionsFor(error?.code ?? null, backups.length > 0),
    backups: backups.map(publicBackup),
    suggested,
    folder: backupsDir(deps.dataDir),
  };
}

/** While running: the status, the backups, and "Back up now". */
export function startupRoutes(deps: StartupDeps) {
  const r = new Hono<AppEnv>();
  r.get('/system/startup', async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(await startupStatus(deps, null, c.get('traceId')));
  });
  r.get('/system/backups', async (c) =>
    c.json({
      items: (await listBackups(deps.dataDir)).map(publicBackup),
      folder: backupsDir(deps.dataDir),
    } satisfies system.BackupList),
  );
  r.post('/system/backups', async (c) => {
    const s = deps.schema();
    const b = await takeBackup({
      url: deps.url,
      sql: deps.sql,
      dataDir: deps.dataDir,
      reason: 'manual',
      appVersion: deps.version,
      coreSchema: s.current,
      knowledgeRevision: null,
      ...(deps.tools && { tools: deps.tools }),
    });
    return c.json(publicBackup(b), 201);
  });
  return r;
}

/** For the desktop host (service token): a backup before it installs an older build. */
export function startupInternalRoutes(deps: StartupDeps) {
  const r = new Hono<AppEnv>();
  r.post('/desktop/backup', async (c) => {
    const req = await body(c, system.DesktopBackupRequest);
    const s = deps.schema();
    const b = await takeBackup({
      url: deps.url,
      sql: deps.sql,
      dataDir: deps.dataDir,
      reason: req.reason,
      appVersion: deps.version,
      coreSchema: s.current,
      knowledgeRevision: null,
      ...(deps.tools && { tools: deps.tools }),
    });
    return c.json(publicBackup(b), 201);
  });
  return r;
}

export interface StoppedDeps extends StartupDeps {
  error: AncileError;
  /** The built Cockpit, which shows the start-up screen. */
  cockpitDist?: string;
  allowedOrigins: string[];
  /** Run by the desktop app, which starts every service again on RESTART_ALL_EXIT. */
  managed: boolean;
  exit?: (code: number) => void;
}

/** Core when it stopped before opening the database: the start-up screen and its actions. */
export function stoppedApp(deps: StoppedDeps) {
  const app = new Hono<AppEnv>();
  const exit = deps.exit ?? ((code: number) => setTimeout(() => process.exit(code), 300).unref());
  let error = deps.error;
  app.use('*', traceMiddleware());
  app.onError(errorHandler);
  app.get('/health', (c) => c.json({ ok: true, service: 'core', version: deps.version, stopped: true }));
  // Ready, so the desktop app opens the window: what it shows is the start-up screen.
  app.get('/ready', (c) => c.json({ ok: true, stopped: true, checks: { startup: false } }));

  const api = new Hono<AppEnv>();
  api.use('*', requestGuard({ origins: deps.allowedOrigins }));
  api.get('/system/startup', async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(await startupStatus(deps, error, c.get('traceId')));
  });
  const restart = (c: Context<AppEnv>, extra: Record<string, unknown>) => {
    if (deps.managed) exit(RESTART_ALL_EXIT);
    return c.json({ ...extra, restarting: deps.managed });
  };
  api.post('/system/startup/restore', async (c) => {
    const req = await body(c, system.RestoreRequest);
    const s = deps.schema();
    const { restored, safety } = await restoreBackup({
      url: deps.url,
      sql: deps.sql,
      dataDir: deps.dataDir,
      name: req.backup,
      appVersion: deps.version,
      coreSchema: s.current,
      knowledgeRevision: null,
      ...(deps.tools && { tools: deps.tools }),
    });
    log.info({ backup: restored.name }, 'restored from the start-up screen');
    // What is on disk now is the backup: until a restart, say so rather than the old error.
    error = new AncileError({
      code: 'system.restart_needed',
      title: 'The backup was restored',
      hint: deps.managed ? 'NVX Ancile is starting again.' : 'Restart NVX Ancile (pnpm start) to open it.',
      status: 503,
      errorClass: 'transient',
    });
    return restart(c, { restored: publicBackup(restored), safety: publicBackup(safety) });
  });
  api.post('/system/startup/retry', (c) => restart(c, {}));
  api.post('/system/startup/continue-without-backup', async (c) => {
    if (error.code !== 'system.backup_failed')
      throw new AncileError({
        code: 'request.conflict',
        title: 'There is no failed backup to skip',
        hint: 'Choose another action on this screen.',
        status: 409,
        errorClass: 'permanent',
      });
    await chooseNoBackup(deps.dataDir);
    return restart(c, {});
  });
  api.all('*', () => {
    throw error;
  });
  app.route('/api/v1', api);
  app.all('/internal/*', () => {
    throw error;
  });

  if (deps.cockpitDist) {
    const dist = deps.cockpitDist;
    app.use('/assets/*', serveStatic({ root: dist }));
    app.use('/*', cockpitPageHeaders(), serveStatic({ root: dist }));
    app.get('*', async (c) => {
      try {
        return c.html(await readFile(join(dist, 'index.html'), 'utf8'));
      } catch {
        return c.text(`${error.title}\n\n${error.hint}\n`, 503);
      }
    });
  }
  return app;
}
