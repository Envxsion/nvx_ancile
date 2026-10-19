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

export const BackupReason = z.enum([
  'before-migration',
  'before-downgrade',
  'before-restore',
  /** MT1: taken just before Tidy storage changes anything. */
  'before-tidy',
  'manual',
]);
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
 * A restore chosen from the setup step (ROADMAP SU1). It is staged first, applied when
 * NVX Ancile restarts (Core is then the only thing using the database), and kept until
 * it finishes, so a large one carries on after a restart.
 */
export const StagedRestore = z.object({
  backup: z.string(),
  bytes: z.number().int().nonnegative(),
  staged_at: z.string(),
  /** staged: chosen, nothing changed. restarting: apply it on the next start. running: being applied. failed / done: over. */
  state: z.enum(['staged', 'restarting', 'running', 'failed', 'done']),
  /** Where a running restore is. */
  step: z.enum(['waiting', 'safety', 'clearing', 'restoring', 'done']),
  /** Starts so far; more than one means it carried on after a restart. */
  attempts: z.number().int().nonnegative(),
  /** The safety copy of what was there before, once taken. */
  safety: z.string().nullable(),
  error: z.object({ title: z.string(), hint: z.string() }).nullable(),
});
export type StagedRestore = z.infer<typeof StagedRestore>;

/** POST /api/v1/system/restore/stage: choose a backup to restore. Changes nothing yet. */
export const StageRestoreRequest = z.object({ backup: z.string().min(1).max(200) }).strict();
export type StageRestoreRequest = z.infer<typeof StageRestoreRequest>;

/** GET /api/v1/system/restore */
export const StagedRestoreState = z.object({
  restore: StagedRestore.nullable(),
  /** Whether "Restart and restore" restarts by itself (the desktop app) or you restart it. */
  managed: z.boolean(),
});
export type StagedRestoreState = z.infer<typeof StagedRestoreState>;

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
  /** A restore chosen in setup that is waiting, running or finished (absent from an older Core). */
  restore: StagedRestore.nullable().optional(),
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

/** POST /api/v1/system/tidy (ROADMAP MT1): what Tidy storage did, or with dry_run what it would do. */
export const TidyRequest = z.object({ dry_run: z.boolean().default(false) }).strict();
export type TidyRequest = z.infer<typeof TidyRequest>;

export const TidyReport = z.object({
  dry_run: z.boolean(),
  /** The backup taken first (absent on a dry run). */
  backup: z.string().nullable(),
  chunks_removed: z.number().int().nonnegative(),
  parents_removed: z.number().int().nonnegative(),
  /** Old version bodies that were the same bytes as another and now share one file. */
  bodies_linked: z.number().int().nonnegative(),
  /** Space the shared files give back, in bytes. */
  bytes_freed: z.number().int().nonnegative(),
  vacuumed: z.boolean(),
  /** One plain sentence for the Admin page and the Automations page. */
  summary: z.string(),
});
export type TidyReport = z.infer<typeof TidyReport>;
