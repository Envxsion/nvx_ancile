/**
 * ------------------------------------------------------------------
 *  Title    |  Knowledge tests against your own Postgres
 *  ID       |  scripts
 * ------------------------------------------------------------------
 *  Purpose  |  `pnpm test:py`: run the Knowledge suite with the same
 *           |  database settings the stack uses, so the database
 *           |  tests run instead of skipping. They use their own
 *           |  database (ancile_kn_test) on that server.
 *  How      |  composeEnv() (.env over generated secrets) supplies
 *           |  DATABASE_URL; nothing is printed. Extra arguments go
 *           |  to pytest. Start Postgres first (pnpm start).
 * ------------------------------------------------------------------
 */

import { spawnSync } from 'node:child_process';
import { IS_WIN, ROOT, readEnv } from './lib.mjs';
import { composeEnv } from './runtime.mjs';

const env = composeEnv(readEnv());
const res = spawnSync(
  'uv',
  ['run', '--directory', 'services/knowledge', 'pytest', ...process.argv.slice(2)],
  {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WIN,
    env: {
      ...process.env,
      ...(process.env.ANCILE_TEST_DATABASE_URL ? {} : { DATABASE_URL: env.DATABASE_URL }),
      PYTHONUTF8: '1',
    },
  },
);
process.exit(res.status ?? 1);
