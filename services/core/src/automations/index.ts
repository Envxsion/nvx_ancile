/**
 * ------------------------------------------------------------------
 *  Title    |  Automations
 *  Ref      |  DESIGN.md §13.6, config/automations.yaml
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The quiet work: titles, memory capture, branch
 *           |  suggestions, the context watch, the knowledge jobs,
 *           |  drafts, stale-source checks, clean-up, memory backups.
 *  How      |  Scheduled jobs: runner.ts (a cron tick on Postgres rows,
 *           |  no extra queue); the built-ins in jobs.ts, your own
 *           |  (ask a model, run a flow, re-check links, remind me) in
 *           |  userJobs.ts. Event-driven jobs live with the
 *           |  features they serve (titles in threads, capture in
 *           |  memory, and so on), which read their switch and
 *           |  settings through BuiltinSettings (settings.ts).
 * ------------------------------------------------------------------
 */

export { cronWords, nextRun, parseCron, scheduleProblem } from './cron';
export { builtinOptions, jobSetup, memoryCaptureLink, scheduledJobs, testMemoryPush } from './jobs';
export { automationRoutes } from './routes';
export { AutomationRunner, CATALOGUE, MemoryAutomationStore, PgAutomationStore } from './runner';
export { ALWAYS_ON, BuiltinSettings, type JobSwitches, KnowledgeSync } from './settings';
export { userJobs } from './userJobs';
