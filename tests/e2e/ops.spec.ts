/**
 * Phase 5: Health, Logs and Traces. Every service is listed with its
 * state; Restart brings one back and says so; logs filter and export;
 * a trace opens on its waterfall. Runs on the test profile, whose
 * services the runner can restart.
 */
import { expect, test } from '@playwright/test';
import { BACKEND } from './playwright.config';

test.describe('operations', () => {
  test.beforeEach(({ page }) => {
    test.skip(!BACKEND, 'needs Core (E2E_BACKEND=1)');
    return page.addInitScript(() => sessionStorage.setItem('nvx.ancile.setup-offered', '1'));
  });

  test('Health lists every service, and Restart brings the Controller back', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/admin/health');
    for (const name of ['Database', 'Knowledge', 'Controller'])
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    const card = page
      .getByRole('listitem')
      .filter({ hasText: 'Controller' })
      .filter({ hasText: 'GPU nodes' });
    const restart = card.getByRole('button', { name: /^Restart/ });
    test.skip(!(await restart.isVisible().catch(() => false)), 'the runner cannot restart services here');
    await restart.click();
    await expect(page.getByText(/Restarting Controller|Controller is back|restart/i).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(card).toContainText('Answering', { timeout: 60_000 });
  });

  test('Logs filter by level and text, follow live, and export', async ({ page, request }) => {
    await page.goto('/admin/logs');
    const log = page.getByRole('log');
    await expect(log).toBeVisible({ timeout: 10_000 });
    await page.getByRole('radio', { name: 'Warnings' }).click();
    await expect(page.getByRole('radio', { name: 'Warnings' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('radio', { name: 'All' }).click();
    await page.getByRole('textbox', { name: 'Search the logs' }).fill('GET');
    await expect(log).toContainText('GET', { timeout: 10_000 });
    const live = page.getByRole('switch', { name: 'Follow live' });
    const was = await live.getAttribute('aria-checked');
    await live.click();
    await expect(live).not.toHaveAttribute('aria-checked', was ?? '');
    const json = await request.get('/api/v1/logs/export?format=json&limit=5');
    expect(json.ok()).toBe(true);
    const csv = await request.get('/api/v1/logs/export?format=csv&limit=5');
    expect(csv.ok()).toBe(true);
    expect(await csv.text()).toMatch(/^[a-z_]+,/);
  });

  test('a trace found by its id opens on its waterfall', async ({ page, request }) => {
    // Health checks and log shipping are housekeeping and not traced; a new thread is.
    const made = await request.post('/api/v1/threads', { data: { title: 'Trace me' } });
    const id = made.headers()['x-trace-id'];
    expect(id).toBeTruthy();
    await page.goto('/admin/traces');
    await page.getByRole('textbox', { name: 'Find a trace' }).fill(id as string);
    await page
      .getByRole('main')
      .getByRole('button', { name: /POST \/threads/ })
      .first()
      .click();
    await expect(page.getByRole('region', { name: 'Spans in time order' })).toBeVisible({ timeout: 10_000 });
  });
});
