/**
 * End-to-end tests (ROADMAP.md, every phase).
 *
 * By default this starts the Cockpit dev server on :7701 (demo fixtures).
 * Specs that need the backend run with E2E_BACKEND=1 against the test
 * profile, `pnpm start:e2e`, on :7801 (its own ports, database and data).
 *
 * Self-healing paths are tested with Core's fake provider (deterministic
 * streams, scripted tool calls, injectable failures), never real networks.
 */
import { defineConfig, devices } from '@playwright/test';

// Backend specs run against the test profile (`pnpm start:e2e`, Cockpit on
// :7801) so your everyday stack on :7701 can keep running beside it.
const baseURL =
  process.env.E2E_BASE_URL ?? (process.env.E2E_BACKEND ? 'http://localhost:7801' : 'http://localhost:7701');
const external = Boolean(process.env.E2E_BASE_URL || process.env.E2E_BACKEND);

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    // The crawl presses every switch, so it changes shared settings while it
    // runs: it never runs beside the journeys (run it on its own, as CI does).
    {
      name: 'chromium-dark',
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark' },
      testIgnore: process.env.E2E_CRAWL ? undefined : /crawl\.spec\.ts$/,
    },
    { name: 'chromium-light', use: { ...devices['Desktop Chrome'], colorScheme: 'light' } },
    {
      name: 'tablet',
      use: { ...devices['iPad Pro 11'], colorScheme: 'dark' },
      testIgnore: /crawl\.spec\.ts$/,
    },
    // Phone width in Chromium: the crawl and the phone journeys.
    {
      name: 'phone',
      use: { ...devices['Pixel 7'], colorScheme: 'dark' },
      testMatch: /(crawl|phone)\.spec\.ts$/,
    },
    {
      name: 'reduced-motion',
      use: { ...devices['Desktop Chrome'], reducedMotion: 'reduce' },
      testMatch: /shell\.spec\.ts$/,
    },
  ],
  webServer: external
    ? undefined
    : {
        command: 'pnpm --filter @nvx/ancile-cockpit run dev',
        url: baseURL,
        cwd: '../..',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});

export const BACKEND = Boolean(process.env.E2E_BACKEND);
