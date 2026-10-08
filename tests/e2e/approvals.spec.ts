/**
 * Phase 2: the three tiers end to end. The offline test model's
 * "/tool <name> <json>" directive makes it call a real built-in tool, so
 * the permission gate, the dialog, grants and the decision log all run for
 * real. Each test works in its own folder so parallel runs never share a
 * grant. (A run waiting on approval surviving a Core restart is covered by
 * services/core/test/conductor/turn.test.ts and was checked live.)
 */
import { expect, type Page, test } from '@playwright/test';
import { BACKEND } from './playwright.config';

const lastAnswer = (page: Page) => page.locator('article.msg[data-role="assistant"]').last();
/** The answer is finished (its footer shows the cost), so the thread takes the next message. */
const settled = (page: Page) =>
  expect(lastAnswer(page).locator('.msg__foot')).toBeVisible({ timeout: 15_000 });
const folder = () => `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function ask(page: Page, text: string, fresh = false) {
  if (fresh) {
    await page.goto('/');
    await page.getByRole('textbox', { name: 'Message' }).fill(text);
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await page.waitForURL(/\/t\/thr_/);
  } else {
    await page.getByRole('textbox', { name: 'Message' }).fill(text);
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
  }
}

test.describe('approvals', () => {
  test.beforeEach(({ page }) => {
    test.skip(!BACKEND, 'needs Core (E2E_BACKEND=1)');
    return page.addInitScript(() => sessionStorage.setItem('nvx.ancile.setup-offered', '1'));
  });

  test('reads run without asking', async ({ page }) => {
    await ask(page, '/tool fs_list {}', true);
    await expect(lastAnswer(page).locator('.tool-step')).toContainText('Listed', { timeout: 15_000 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('gated: asks once, and the remembered pattern covers the next write', async ({ page }) => {
    const dir = folder();
    await ask(page, `/tool fs_write {"path":"${dir}/a.md","content":"A"}`, true);
    await lastAnswer(page).getByRole('button', { name: 'Review the request' }).click({ timeout: 15_000 });
    const dialog = page.getByRole('dialog', { name: /allow the agent/i });
    await expect(dialog).toContainText(`${dir}/a.md`);
    await dialog.getByText(`fs:/workspace/${dir}/**`).click();
    await dialog.getByRole('radio', { name: 'In this thread' }).click();
    await dialog.getByRole('button', { name: 'Approve and remember' }).click();
    await expect(lastAnswer(page).locator('.tool-step')).toContainText(`Wrote ${dir}/a.md`, {
      timeout: 15_000,
    });
    await settled(page);

    await ask(page, `/tool fs_write {"path":"${dir}/b.md","content":"B"}`);
    await expect(lastAnswer(page).locator('.tool-step')).toContainText(`Wrote ${dir}/b.md`, {
      timeout: 15_000,
    });
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('critical: asks every time and offers no way to remember', async ({ page }) => {
    const dir = folder();
    await ask(page, `/tool fs_delete {"path":"${dir}/gone.md"}`, true);
    for (let i = 0; i < 2; i++) {
      await lastAnswer(page).getByRole('button', { name: 'Review the request' }).click({ timeout: 15_000 });
      const dialog = page.getByRole('dialog', { name: /go-ahead/i });
      await expect(dialog).toContainText('Critical actions are never remembered');
      await expect(dialog.getByRole('radio', { name: /always|this thread/i })).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Decline' }).click();
      await expect(lastAnswer(page).locator('.tool-step')).toContainText(`Didn't delete ${dir}/gone.md`, {
        timeout: 15_000,
      });
      if (i === 0) {
        await settled(page);
        await ask(page, `/tool fs_delete {"path":"${dir}/gone.md"}`);
      }
    }
  });

  test('Admin lists the grant, revokes it, and logs every decision', async ({ page }) => {
    const dir = folder();
    await ask(page, `/tool fs_write {"path":"${dir}/x.md","content":"x"}`, true);
    await lastAnswer(page).getByRole('button', { name: 'Review the request' }).click({ timeout: 15_000 });
    const dialog = page.getByRole('dialog', { name: /allow the agent/i });
    await dialog.getByText(`fs:/workspace/${dir}/**`).click();
    await dialog.getByRole('radio', { name: 'Always' }).click();
    await dialog.getByRole('button', { name: 'Approve and remember' }).click();
    await expect(lastAnswer(page).locator('.tool-step')).toContainText('Wrote', { timeout: 15_000 });

    await page.goto('/admin/grants');
    const row = page.getByRole('row', { name: new RegExp(`${dir}`) });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /revoke/i }).click();
    await expect(row).toHaveCount(0);

    await page.goto('/admin/decisions');
    await expect(page.getByRole('row', { name: new RegExp(`${dir}/x.md`) }).first()).toContainText(
      'You approved',
    );
  });
});
