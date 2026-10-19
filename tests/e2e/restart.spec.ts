/**
 * Phase 5: Health. Every service is listed with its state; Restart brings the Controller back and says so.
 * Restarting drops the sample nodes' state and notices "restarting" to every open browser, so this runs
 * alone, after the other projects (playwright.config.ts, project "restart"), against the test profile whose
 * services the runner can restart.
 */
import { expect, test } from '@playwright/test';
import { BACKEND } from './playwright.config';

test.describe('operations: restart', () => {
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
});
