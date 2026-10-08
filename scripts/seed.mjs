#!/usr/bin/env node
/**
 * ------------------------------------------------------------------
 *  Title    |  pnpm seed
 *  ID       |  scripts
 * ------------------------------------------------------------------
 *  Purpose  |  Fill the running dev workspace with a believable world
 *           |  (notebooks, sources, branching threads, fact-checks,
 *           |  memory, notes, approvals), so you can see what NVX
 *           |  Ancile feels like in use. `pnpm seed --reset` removes
 *           |  exactly what it added and nothing else.
 *  How      |  Works out the same environment `pnpm start` uses, then
 *           |  runs services/core/scripts/seed.ts with tsx, so the
 *           |  seeder can use Core's own scoring code.
 *  Note     |  Needs the stack running (`pnpm start`).
 * ------------------------------------------------------------------
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, readEnv } from './lib.mjs';
import { composeEnv } from './runtime.mjs';

// `pnpm seed --e2e` fills the test profile (`pnpm start:e2e`) instead.
const e2e = process.argv.includes('--e2e');
if (e2e) process.env.ANCILE_PROFILE = 'e2e';
const env = composeEnv(readEnv());
const res = spawnSync(
  process.execPath,
  ['--import', 'tsx', join('scripts', 'seed.ts'), ...process.argv.slice(2).filter((a) => a !== '--e2e')],
  {
    cwd: join(ROOT, 'services', 'core'),
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: env.DATABASE_URL,
      ANCILE_SEED_API: `http://127.0.0.1:${env.ANCILE_PORT ?? '7700'}/api/v1`,
      ANCILE_SEED_ROOT: ROOT,
    },
  },
);
process.exit(res.status ?? 1);
