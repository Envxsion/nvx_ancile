/**
 * Phase 5b: flows. Start one from a template, try it with mock models,
 * turn it on, and a message is answered through it with the teamwork
 * shown under the answer; regenerate offers "Route again". Templates use
 * the models this workspace has, so the offline models do here.
 */
import { expect, type Page, test } from '@playwright/test';
import { BACKEND } from './playwright.config';

const lastAnswer = (page: Page) => page.locator('article.msg[data-role="assistant"]').last();

test.describe('flows', () => {
  test.describe.configure({ mode: 'serial' });
  let flowId = '';

  test.beforeEach(({ page }) => {
    test.skip(!BACKEND, 'needs Core (E2E_BACKEND=1)');
    return page.addInitScript(() => sessionStorage.setItem('nvx.ancile.setup-offered', '1'));
  });

  test.afterAll(async ({ request }) => {
    // Leave the workspace answering without a flow, as it started.
    if (flowId) await request.post(`/api/v1/flows/${flowId}/activate`, { data: { on: false } });
  });

  test('start from a template and try it with mock models', async ({ page }) => {
    await page.goto('/flows');
    await page
      .getByRole('button', { name: /New flow/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: /Start a flow/ });
    await dialog.getByRole('radio', { name: /Router to specialists/ }).click();
    const name = `E2E router ${Date.now()}`;
    await dialog.getByRole('textbox').first().fill(name);
    await dialog.getByRole('button', { name: /^Create from/ }).click();
    await page.waitForURL(/\/flows\/flw_/);
    flowId = page.url().split('/').pop() ?? '';

    await page.getByRole('button', { name: /^Try$/ }).click();
    await page.getByRole('textbox', { name: 'Message to try' }).fill('Write a regex for UK postcodes');
    const mock = page.getByRole('switch', { name: 'Mock models' });
    if ((await mock.getAttribute('aria-checked')) !== 'true') await mock.click();
    await page.getByRole('button', { name: /^Run$/ }).click();
    await expect(page.getByText('The answer', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^Done$/).first()).toBeVisible({ timeout: 30_000 });
  });

  test('turned on, it answers a message, shows its teamwork, and can route again', async ({
    page,
    request,
  }) => {
    test.skip(!flowId, 'the first test made the flow');
    const on = await request.post(`/api/v1/flows/${flowId}/activate`, { data: { on: true } });
    expect(on.ok(), await on.text()).toBe(true);

    await page.goto('/');
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('Fix this regex: ^[A-Z]{1,2}[0-9]');
    await composer.press('Enter');
    await page.waitForURL(/\/t\/thr_/);
    const teamwork = lastAnswer(page).getByRole('region', { name: /^How this answer was made/ });
    await expect(teamwork).toBeVisible({ timeout: 30_000 });
    await expect(lastAnswer(page).locator('.msg__foot')).toBeVisible({ timeout: 30_000 });
    await teamwork.getByRole('button', { expanded: false }).first().click();
    await expect(teamwork.getByRole('figure', { name: /path this answer took/ })).toBeVisible();

    await lastAnswer(page).hover();
    await lastAnswer(page)
      .getByRole('button', { name: /^Regenerate: / })
      .click();
    await page.getByRole('menuitem', { name: 'Route again', exact: true }).click();
    await expect(lastAnswer(page).getByRole('group', { name: 'Versions of this message' })).toContainText(
      '2 / 2',
      { timeout: 30_000 },
    );
  });
});
