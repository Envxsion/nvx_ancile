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
import { expectAccessible, mod, DEMO_ROUTES as ROUTES } from './fixtures';
import { BACKEND } from './playwright.config';

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

  // The Pro edition: the brighter palette and the gilt kit hold AA too.
  for (const route of ['/admin/license', '/admin/engine-insights', '/admin/fleet'])
    test(`${route} in the Pro edition has no serious or critical axe violation`, async ({ page }) => {
      const features = ['beam', 'team', 'sync', 'fleet', 'flow_lab', 'insights'];
      await page.addInitScript(() => localStorage.setItem('nvx.ancile.pro-awakened', '1'));
      await page.route('**/api/v1/license/details', (r) =>
        r.fulfill({
          json: {
            status: {
              tier: 'pro',
              features,
              verified: true,
              offline_grace: false,
              expires_at: '2030-01-01T00:00:00Z',
              lapse: null,
            },
            build: 'pro',
            device_id: 'dev_1',
            key_held: true,
            checked_at: null,
            problem: null,
            features: features.map((id) => ({ id, title: id, body: id, unlocked: true })),
          },
        }),
      );
      await open(page, route);
      await expect(page.locator('html')).toHaveAttribute('data-edition', 'pro');
      await expectAccessible(page);
    });

  test('the command palette, open', async ({ page }) => {
    await open(page, '/');
    await page.keyboard.press(`${mod}+k`);
    await expect(page.getByRole('dialog', { name: /command/i })).toBeVisible();
    await expectAccessible(page);
  });

  test('the activity panel, open', async ({ page }) => {
    await open(page, '/');
    await page.getByRole('button', { name: /running\. Show activity/ }).click();
    const panel = page.getByRole('dialog', { name: 'Activity' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: /Background shells/ })).toBeVisible();
    await expectAccessible(page);
  });
});
