/**
 * Phase 2, the lab lane: "Run in the lab" hands a message to the agent
 * engine, its write asks through Ancile's dialog, the change is listed,
 * and Undo puts the folder back. Needs the engine (Bun): E2E_LAB=1.
 */
import { expect, type Page, test } from '@playwright/test';
import { BACKEND } from './playwright.config';

const lastAnswer = (page: Page) => page.locator('article.msg[data-role="assistant"]').last();

test('run in the lab, approve its write, see the change, undo it', async ({ page }) => {
  test.skip(!BACKEND || !process.env.E2E_LAB, 'needs Core and the lab engine (E2E_BACKEND=1 E2E_LAB=1)');
  await page.addInitScript(() => sessionStorage.setItem('nvx.ancile.setup-offered', '1'));
  const file = `lab-${Date.now().toString(36)}.txt`;
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill(`/tool write {"filePath":"${file}","content":"from the lab"}`);
  await composer.press('Enter');
  await page.waitForURL(/\/t\/thr_/);
  await expect(lastAnswer(page).locator('.msg__foot')).toBeVisible({ timeout: 15_000 });

  const mine = page.locator('article.msg[data-role="user"]').last();
  await mine.hover();
  await mine.getByRole('button', { name: 'Run in the lab' }).click();
  await expect(lastAnswer(page).locator('.model-tag')).toHaveText('The lab', { timeout: 20_000 });
  await lastAnswer(page).getByRole('button', { name: 'Review the request' }).click({ timeout: 30_000 });
  await page.getByRole('dialog').getByRole('button', { name: 'Approve once' }).click();

  const changes = lastAnswer(page).getByRole('region', { name: 'Files the lab changed' });
  await expect(changes).toContainText(file, { timeout: 30_000 });
  await changes.getByRole('button', { name: 'Undo these changes' }).click();
  await expect(changes).toContainText('Undone', { timeout: 15_000 });
});
