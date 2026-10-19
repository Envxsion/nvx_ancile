/**
 * ------------------------------------------------------------------
 *  Title    |  Apply a staged restore at start
 *  Ref      |  ROADMAP SU1 · docs/runbooks/restore-backup.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Run a restore chosen in setup before Core opens the
 *           |  database, while the window shows its progress.
 *  How      |  Serves the start-up screen (system/startup.ts) with the
 *           |  error system.restoring, whose status carries the
 *           |  marker (system/stagedRestore.ts), applies the restore
 *           |  in the background, then asks the desktop app to start
 *           |  every service again. Elsewhere it stays up saying
 *           |  "restored, restart NVX Ancile".
 *  Note     |  Nothing else touches the database meanwhile: this runs
 *           |  before migrations, jobs and every other service of
 *           |  Core.
 * ------------------------------------------------------------------
 */

import { applyStaged, stagedErrors } from './stagedRestore';
import { RESTART_ALL_EXIT, type StoppedDeps, stoppedApp } from './startup';

export interface BootRestoreDeps extends Omit<StoppedDeps, 'error'> {
  /** Start listening with this handler (the same port Core would use). */
  listen: (fetch: (req: Request) => Response | Promise<Response>) => void;
  /** How long the finished screen stays up before a managed restart. */
  lingerMs?: number;
}

export async function bootRestore(deps: BootRestoreDeps): Promise<void> {
  const { listen, lingerMs = 2500, ...rest } = deps;
  const app = stoppedApp({ ...rest, error: stagedErrors.restoring() });
  listen(app.fetch);
  const after = await applyStaged(rest);
  // A finished restore starts everything again; a failed one stays on screen with its reason.
  if (after?.state === 'done' && rest.managed) {
    const exit = rest.exit ?? ((code: number) => process.exit(code));
    setTimeout(() => exit(RESTART_ALL_EXIT), lingerMs).unref();
  }
}
