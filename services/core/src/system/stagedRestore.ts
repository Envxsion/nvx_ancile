/**
 * ------------------------------------------------------------------
 *  Title    |  Staged restore (restore from the setup step)
 *  Ref      |  ROADMAP SU1 · docs/runbooks/restore-backup.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Let a first run restore a backup without leaving
 *           |  setup, even though a restore replaces the whole
 *           |  database and so cannot run under a live Core.
 *  How      |  A small marker (<data>/backups/restore-staged.json)
 *           |  carries the choice through its states: staged (chosen,
 *           |  nothing changed), restarting (apply it on the next
 *           |  start), running, then done or failed. Core applies a
 *           |  restarting or running one at the very start, before it
 *           |  opens the database, serving only the start-up screen
 *           |  with the marker as its progress. A restore that a
 *           |  restart interrupted starts again from the marker; the
 *           |  safety copy is not taken twice, so it is never pruned
 *           |  for a half-cleared database. Restoring is one pg_restore
 *           |  transaction, so an interrupted one leaves nothing half
 *           |  done and the retry is safe.
 *  Note     |  Backups are not encrypted, so there is no passphrase to
 *           |  get wrong here; a backup that cannot be read is
 *           |  system.restore_failed, with the safety copy named.
 *           |  A backup is chosen by name from the list, never a path.
 * ------------------------------------------------------------------
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AncileError, system } from '@nvx/contracts';
import type { Spawner } from '../claudecode/cli';
import { backupErrors, backupsDir, listBackups, restoreBackup } from '../db/backup';
import { logFor } from '../obs/logger';
import type { StatFs } from './disk';
import type { StartupDeps } from './startup';

const log = logFor('staged-restore');

export const STAGED_FILE = 'restore-staged.json';
/** Starts in a row that may try a restore before it is marked failed. */
export const MAX_ATTEMPTS = 3;
const fileOf = (dataDir: string) => join(backupsDir(dataDir), STAGED_FILE);

export const stagedErrors = {
  notStaged: () =>
    new AncileError({
      code: 'system.restore_not_staged',
      title: 'No restore is waiting',
      hint: 'Choose a backup first, then restart to restore it.',
      status: 409,
      errorClass: 'permanent',
    }),
  busy: () =>
    new AncileError({
      code: 'system.restore_in_progress',
      title: 'A restore is already under way',
      hint: 'Wait for it to finish. It carries on by itself if NVX Ancile is restarted.',
      status: 409,
      errorClass: 'transient',
    }),
  restoring: () =>
    new AncileError({
      code: 'system.restoring',
      title: 'Restoring your backup',
      hint: 'This can take a while for a large backup. If NVX Ancile is closed, it carries on the next time it starts.',
      status: 503,
      errorClass: 'transient',
    }),
};

/** The marker, or null when there is none (or it cannot be read). */
export async function readStaged(dataDir: string): Promise<system.StagedRestore | null> {
  try {
    const parsed = system.StagedRestore.safeParse(JSON.parse(await readFile(fileOf(dataDir), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function write(dataDir: string, m: system.StagedRestore): Promise<system.StagedRestore> {
  const path = fileOf(dataDir);
  await writeFile(`${path}.tmp`, `${JSON.stringify(m, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
  return m;
}

const active = (m: system.StagedRestore | null) => m?.state === 'restarting' || m?.state === 'running';

/** Choose a backup to restore. Changes nothing but the marker. */
export async function stageRestore(
  dataDir: string,
  name: string,
  now = () => new Date(),
): Promise<system.StagedRestore> {
  if (active(await readStaged(dataDir))) throw stagedErrors.busy();
  const chosen = (await listBackups(dataDir)).find((b) => b.name === name);
  if (!chosen) throw backupErrors.unknown(name);
  return write(dataDir, {
    backup: chosen.name,
    bytes: chosen.bytes,
    staged_at: now().toISOString(),
    state: 'staged',
    step: 'waiting',
    attempts: 0,
    safety: null,
    error: null,
  });
}

/** Forget the choice (or a finished or failed one). Not while it is being applied. */
export async function clearStaged(dataDir: string): Promise<void> {
  if (active(await readStaged(dataDir))) throw stagedErrors.busy();
  await rm(fileOf(dataDir), { force: true });
}

/** "Restart and restore": from now the next start applies it. */
export async function requestApply(dataDir: string): Promise<system.StagedRestore> {
  const m = await readStaged(dataDir);
  if (!m || (m.state !== 'staged' && m.state !== 'failed')) throw stagedErrors.notStaged();
  return write(dataDir, { ...m, state: 'restarting', attempts: 0, error: null });
}

/** Whether Core must apply a restore before it opens the database. */
export const mustApply = (m: system.StagedRestore | null): m is system.StagedRestore => active(m);

/** Apply the staged restore, writing each step to the marker. Never throws: a failure is the marker's `failed`. */
export async function applyStaged(
  deps: Pick<StartupDeps, 'sql' | 'url' | 'dataDir' | 'version' | 'schema' | 'tools'> & {
    run?: Spawner;
    statfs?: StatFs;
  },
): Promise<system.StagedRestore | null> {
  const start = await readStaged(deps.dataDir);
  if (!mustApply(start)) return start;
  // A restore that took Core down with it would otherwise be retried on every start, for ever.
  if (start.attempts >= MAX_ATTEMPTS)
    return write(deps.dataDir, {
      ...start,
      state: 'failed',
      error: {
        title: 'The backup could not be restored',
        hint: `It stopped NVX Ancile ${start.attempts} times in a row. Try it again from setup, or see docs/runbooks/restore-backup.md to restore it by hand.`,
      },
    });
  let m = await write(deps.dataDir, {
    ...start,
    state: 'running',
    attempts: start.attempts + 1,
    error: null,
  });
  // Past the safety copy on an earlier start: it holds what was there, so it is not taken again.
  const resume =
    start.safety !== null ||
    (start.state === 'running' && (start.step === 'clearing' || start.step === 'restoring'));
  const set = async (patch: Partial<system.StagedRestore>) => {
    m = await write(deps.dataDir, { ...m, ...patch });
  };
  try {
    const s = deps.schema();
    await restoreBackup({
      url: deps.url,
      sql: deps.sql,
      dataDir: deps.dataDir,
      name: m.backup,
      appVersion: deps.version,
      coreSchema: s.current,
      knowledgeRevision: null,
      skipSafety: resume,
      ...(deps.tools && { tools: deps.tools }),
      ...(deps.run && { run: deps.run }),
      ...(deps.statfs && { statfs: deps.statfs }),
      onStep: async (step) => {
        await set({ step });
        if (step === 'clearing' && !resume) {
          const safety = (await listBackups(deps.dataDir)).find((b) => b.reason === 'before-restore');
          await set({ safety: safety?.name ?? null });
        }
      },
    });
    await set({ state: 'done', step: 'done' });
    log.info({ backup: m.backup, attempts: m.attempts }, 'staged restore finished');
  } catch (err) {
    const e = err instanceof AncileError ? err : null;
    log.error({ backup: m.backup, err: (err as Error).message }, 'staged restore failed');
    await set({
      state: 'failed',
      error: {
        title: e?.title ?? 'The backup could not be restored',
        hint: e?.hint ?? 'See docs/runbooks/restore-backup.md to restore it by hand.',
      },
    });
  }
  return m;
}
