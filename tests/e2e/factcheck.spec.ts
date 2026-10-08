/**
 * Phase 4: fact-checking. A checked answer carries a chip; the chip opens
 * the Evidence panel with contradictions first; a new answer can be
 * checked from its actions. Runs on the seeded test profile
 * (`pnpm seed --e2e`) and the offline models.
 */
import { expect, type Page, test } from '@playwright/test';
import { BACKEND } from './playwright.config';

async function threadByTitle(page: Page, title: RegExp): Promise<string | undefined> {
  const r = await page.request.get('/api/v1/threads?limit=100');
  const body = (await r.json()) as { items: { id: string; title: string }[] };
  return body.items.find((t) => title.test(t.title))?.id;
}

const lastAnswer = (page: Page) => page.locator('article.msg[data-role="assistant"]').last();

test.describe('fact-check', () => {
  test.beforeEach(({ page }) => {
    test.skip(!BACKEND, 'needs Core (E2E_BACKEND=1)');
    return page.addInitScript(() => sessionStorage.setItem('nvx.ancile.setup-offered', '1'));
  });

  test('a contradicted claim is flagged, and its evidence opens in the panel', async ({ page }) => {
    const id = await threadByTitle(page, /heat pump do we need/i);
    test.skip(!id, 'needs the sample world (pnpm seed --e2e)');
    await page.goto(`/t/${id}`);
    const chip = page
      .getByRole('button', { name: /^Fact-check: .*Open the evidence\.$/ })
      .filter({ hasText: /contradicted/ })
      .first();
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await chip.click();
    const panel = page.getByRole('tabpanel', { name: 'Evidence' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(/contradicted/i);
    await expect(panel).toContainText('Your source says otherwise');
    // Contradictions come first, so the warning cannot be missed.
    await expect(panel.getByText(/^Contradicted/).first()).toBeVisible();
  });

  test('a new answer can be checked from its actions', async ({ page }) => {
    await page.goto('/');
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('/say The Thames flows through London. It is 346 kilometres long.');
    await composer.press('Enter');
    await page.waitForURL(/\/t\/thr_/);
    await expect(lastAnswer(page)).toContainText('Thames', { timeout: 15_000 });
    await expect(lastAnswer(page).locator('.msg__foot')).toBeVisible({ timeout: 15_000 });
    await lastAnswer(page).hover();
    await lastAnswer(page).getByRole('button', { name: 'Fact-check', exact: true }).click();
    await expect(lastAnswer(page).getByRole('button', { name: /^Fact-check: / })).toBeVisible({
      timeout: 30_000,
    });
  });
});
