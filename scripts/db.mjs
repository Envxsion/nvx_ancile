#!/usr/bin/env node
/**
 * ------------------------------------------------------------------
 *  Title    |  pnpm db:backups · db:backup · db:restore <name>
 *  Ref      |  docs/runbooks/restore-backup.md
 *  ID       |  scripts
 * ------------------------------------------------------------------
 *  Purpose  |  The development stack's database backups from the
 *           |  repository root, with the same settings `pnpm start`
 *           |  uses (.env, else the generated secrets in .ancile/).
 *  How      |  Builds the environment like boot.mjs, then runs Core's
 *           |  database commands (services/core/src/db/cli.ts).
 *  Note     |  Restore drops and replaces the database: stop the stack
 *           |  first (`pnpm stop` keeps Postgres running).
 * ------------------------------------------------------------------
 */

import { spawnSync } from 'node:child_process';
import { IS_WIN, ROOT, readEnv } from './lib.mjs';
import { composeEnv } from './runtime.mjs';

const [command, ...rest] = process.argv.slice(2);
if (!['backups', 'backup', 'restore'].includes(command ?? '')) {
  console.error('Use: pnpm db:backups | pnpm db:backup | pnpm db:restore <name>');
  process.exit(1);
}
const env = composeEnv(readEnv());
const r = spawnSync('pnpm', ['--filter', '@nvx/ancile-core', 'run', `db:${command}`, ...rest], {
  cwd: ROOT,
  env: { ...process.env, ...env },
  stdio: 'inherit',
  shell: IS_WIN,
});
process.exit(r.status ?? 1);
