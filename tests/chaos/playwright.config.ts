/**
 * The chaos suite runs against the test profile (`pnpm start:e2e`), one
 * scenario at a time: each breaks something the next one needs.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:7801' },
});
