/**
 * The chaos suite runs against the test profile (`pnpm start:e2e`), one
 * scenario at a time: each breaks something the next one needs.
 *
 * Core answers /api/v1 only to its owner (docs/api.md), so every request
 * carries the test profile's install key, read from its data folder
 * (data/e2e/local-api.key; E2E_KEY_FILE names another). It is never printed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const keyFile =
  process.env.E2E_KEY_FILE ?? fileURLToPath(new URL('../../data/e2e/local-api.key', import.meta.url));
const key = (() => {
  try {
    return readFileSync(keyFile, 'utf8').trim();
  } catch {
    return undefined;
  }
})();

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:7801',
    ...(key && { extraHTTPHeaders: { authorization: `Bearer ${key}` } }),
  },
});
