/**
 * ------------------------------------------------------------------
 *  Title    |  Playwright config for the live suite (LT1)
 *  Ref      |  docs/testing.md · scripts/test-live.mjs
 *  ID       |  tests
 * ------------------------------------------------------------------
 *  Purpose  |  One spec, one worker, no retries, a long timeout. A
 *           |  retry would spend money twice, so there is none.
 *  Note     |  Run it with `pnpm test:live`, never directly: the runner
 *           |  starts the stack with the live guard and sets the
 *           |  environment the spec reads.
 * ------------------------------------------------------------------
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /live\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 45 * 60_000,
  reporter: [['list']],
  outputDir: '../../test-results/live',
  use: { trace: 'retain-on-failure' },
});
