/**
 * Accessibility, blocking (CI job "Accessibility"): every route of the
 * Cockpit, in its demo data, passes axe (WCAG 2.2 AA tags) with no serious or
 * critical violation, in the dark and the light theme. Needs no backend, so it
 * runs fast on every push; the crawl repeats it against the real stack.
 *
 * Also checked open: the command palette, since dialogs are where focus and
 * labels most often go wrong.
 */
import { expect, type Page, test } from '@playwright/test';
import { expectAccessible, mod } from './fixtures';
import { BACKEND } from './playwright.config';

/** The demo data's own ids (apps/cockpit/src/fixtures/demo.ts). */
const DEMO_THREAD = 'thr_01J9ZK00000000000000000BUF';
const DEMO_NOTEBOOK = 'nbk_01J9ZK0000000000000000DEPO';

const SETTINGS = [
  'appearance',
  'layout',
  'reading',
  'composer',
  'keyboard',
  'notifications',
  'accessibility',
  'advanced',
];
const ADMIN = [
  'health',
  'compute',
  'diagnostics',
  'logs',
  'traces',
  'grants',
  'decisions',
  'memory',
  'models',
  'routing',
  'plugins',
  'automations',
  'license',
];

const ROUTES = [
  '/',
  `/t/${DEMO_THREAD}`,
  `/n/${DEMO_NOTEBOOK}`,
  '/flows',
  ...SETTINGS.map((g) => `/settings/${g}`),
  ...ADMIN.map((s) => `/admin/${s}`),
];

async function open(page: Page, route: string) {
  await page.goto(route);
  await page.waitForLoadState('load');
  await expect(page.getByRole('main')).toBeVisible();
}

test.describe('accessibility', () => {
  test.skip(BACKEND, 'runs on the demo data; the crawl covers the real stack');
  test.beforeEach(async ({ page }, info) => {
    test.skip(!/^chromium-(dark|light)$/.test(info.project.name), 'both themes on desktop Chromium');
    await page.addInitScript(() => sessionStorage.setItem('nvx.ancile.setup-offered', '1'));
  });

  for (const route of ROUTES)
    test(`${route} has no serious or critical axe violation`, async ({ page }) => {
      await open(page, route);
      await expectAccessible(page);
    });

  test('the command palette, open', async ({ page }) => {
    await open(page, '/');
    await page.keyboard.press(`${mod}+k`);
    await expect(page.getByRole('dialog', { name: /command/i })).toBeVisible();
    await expectAccessible(page);
  });
});
