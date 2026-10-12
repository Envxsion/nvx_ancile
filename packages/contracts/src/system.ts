/**
 * ------------------------------------------------------------------
 *  Title    |  System: start-up, backups and Pro data
 *  Ref      |  ROADMAP.md track G · docs/desktop.md (Updates and your data)
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  What Core says about its own start (running, or stopped
 *           |  with a reason and what can be done), the database
 *           |  backups it keeps, and Pro's data, readable whatever the
 *           |  licence says.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';
import { ApiError } from './errors';

export const BackupReason = z.enum(['before-migration', 'before-downgrade', 'before-restore', 'manual']);
export type BackupReason = z.infer<typeof BackupReason>;

/** One database backup in <data>/backups. `name` is its id. */
export const Backup = z.object({
  name: z.string(),
  created_at: z.string(),
  reason: BackupReason,
  bytes: z.number().int().nonnegative(),
  /** The NVX Ancile that took it. */
  app_version: z.string().nullable(),
  /** Core's newest migration when it was taken: the schema it restores. */
  core_schema: z.string().nullable(),
  knowledge_revision: z.string().nullable(),
});
export type Backup = z.infer<typeof Backup>;

export const BackupList = z.object({ items: z.array(Backup), folder: z.string() });
export type BackupList = z.infer<typeof BackupList>;

/** What the start-up screen can offer when Core stopped before it was ready. */
export const StartupAction = z.enum(['restore', 'retry', 'continue_without_backup', 'reinstall']);
export type StartupAction = z.infer<typeof StartupAction>;

/**
 * GET /api/v1/system/startup. `running`: everything is up. `stopped`: Core
 * stopped before changing anything, with the reason and what can be done.
 */
export const StartupStatus = z.object({
  state: z.enum(['running', 'stopped']),
  version: z.string(),
  /** The schema this build expects and the one on disk. */
  schema: z.object({ expected: z.string(), current: z.string().nullable() }),
  error: ApiError.shape.error.nullable(),
  actions: z.array(StartupAction),
  backups: z.array(Backup),
  /** The backup this screen suggests restoring (taken before the newer update). */
  suggested: z.string().nullable(),
  /** Where the backups are, to show and to open. */
  folder: z.string(),
});
export type StartupStatus = z.infer<typeof StartupStatus>;

/** POST /api/v1/system/startup/restore */
export const RestoreRequest = z.object({ backup: z.string().min(1).max(200) }).strict();
export type RestoreRequest = z.infer<typeof RestoreRequest>;

/** POST /internal/v1/desktop/backup: the desktop app before it installs an older build. */
export const DesktopBackupRequest = z
  .object({ reason: z.enum(['before-downgrade', 'manual']).default('before-downgrade') })
  .strict();
export type DesktopBackupRequest = z.infer<typeof DesktopBackupRequest>;

/** GET /api/v1/system/pro-data: what Pro keeps, readable in every edition. */
export const ProDataSummary = z.object({
  tables: z.array(z.object({ name: z.string(), rows: z.number().int().nonnegative() })),
  total_rows: z.number().int().nonnegative(),
});
export type ProDataSummary = z.infer<typeof ProDataSummary>;

/** GET /api/v1/system/pro-data/export: every row of Pro's tables, as JSON. */
export const ProDataExport = z.object({
  exported_at: z.string(),
  edition: z.enum(['free', 'pro']),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});
export type ProDataExport = z.infer<typeof ProDataExport>;
