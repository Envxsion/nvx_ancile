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
import {
  PREFS_STORE_KEY,
  prefsStateNeverAdoptingCore,
  UI_STORE_KEY,
  uiStateWithDefaultModel,
} from './global-setup';

// Backend specs run against the test profile (`pnpm start:e2e`, Cockpit on
// :7801) so your everyday stack on :7701 can keep running beside it.
const baseURL =
  process.env.E2E_BASE_URL ?? (process.env.E2E_BACKEND ? 'http://localhost:7801' : 'http://localhost:7701');
/** The Controller restart journey has its own project (see 'restart' below). */
const RESTART = /restart\.spec\.ts$/;
const external = Boolean(process.env.E2E_BASE_URL || process.env.E2E_BACKEND);

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // The dev-server stack is unbundled: too many browsers at once time it out (seen on a 32-core machine).
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    // Against a real Core, every browser starts with the offline test model as its default: Core
    // keeps none, and the Cockpit's own fallback is the first real model that can answer.
    ...(process.env.E2E_BACKEND && {
      storageState: {
        cookies: [],
        origins: [
          {
            origin: new URL(baseURL).origin,
            localStorage: [
              { name: UI_STORE_KEY, value: uiStateWithDefaultModel() },
              { name: PREFS_STORE_KEY, value: prefsStateNeverAdoptingCore() },
            ],
          },
        ],
      },
    }),
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
      testIgnore: process.env.E2E_CRAWL ? RESTART : /(crawl|restart)\.spec\.ts$/,
    },
    {
      name: 'chromium-light',
      use: { ...devices['Desktop Chrome'], colorScheme: 'light' },
      testIgnore: RESTART,
    },
    {
      name: 'tablet',
      use: { ...devices['iPad Pro 11'], colorScheme: 'dark' },
      testIgnore: /(crawl|restart)\.spec\.ts$/,
    },
    // Phone width in Chromium: the crawl and the phone journeys.
    {
      name: 'phone',
      use: { ...devices['Pixel 7'], colorScheme: 'dark' },
      // The crawl presses switches that live on the server (automations, memory), so beside the
      // journeys it would flip them under a running test: with E2E_CRAWL=1 it runs on its own.
      testMatch: process.env.E2E_CRAWL ? /(crawl|phone)\.spec\.ts$/ : /phone\.spec\.ts$/,
    },
    {
      name: 'reduced-motion',
      use: { ...devices['Desktop Chrome'], reducedMotion: 'reduce' },
      testMatch: /shell\.spec\.ts$/,
    },
    // Restarting the Controller drops the sample nodes' state and sends "restarting" notices to every open
    // browser, so it runs by itself, after all the others have finished (not beside compute or onboarding).
    {
      name: 'restart',
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark' },
      testMatch: /restart\.spec\.ts$/,
      dependencies: ['chromium-dark', 'chromium-light', 'tablet', 'phone', 'reduced-motion'],
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
