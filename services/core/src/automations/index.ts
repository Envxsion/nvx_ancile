/**
 * ------------------------------------------------------------------
 *  Title    |  Automations
 *  Ref      |  DESIGN.md §13.6, config/automations.yaml
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The quiet work: titles, TL;DRs, memory capture, branch
 *           |  and model suggestions, stale-source checks, clean-up,
 *           |  memory backups.
 *  How      |  Scheduled jobs: runner.ts (a cron tick on Postgres rows,
 *           |  no extra queue). Event-driven jobs live with the
 *           |  features they serve (titles in threads, capture in
 *           |  memory, and so on).
 * ------------------------------------------------------------------
 */

export { cronWords, nextRun, parseCron } from './cron';
export { scheduledJobs } from './jobs';
export { automationRoutes } from './routes';
export { AutomationRunner, CATALOGUE, MemoryAutomationStore, PgAutomationStore } from './runner';
