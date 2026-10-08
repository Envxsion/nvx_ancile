/**
 * Phase 4: branching. Editing a question starts a new version beside the
 * old one; the tree shows both branches and "you are here"; two branches
 * can be compared and merged into a new thread. Offline models only.
 */
import { expect, type Page, test } from '@playwright/test';
import { BACKEND } from './playwright.config';

const answers = (page: Page) => page.locator('article.msg[data-role="assistant"]');
const questions = (page: Page) => page.locator('article.msg[data-role="user"]');

async function settled(page: Page, text: string) {
  await expect(answers(page).last()).toContainText(text, { timeout: 15_000 });
  await expect(answers(page).last().locator('.msg__foot')).toBeVisible({ timeout: 15_000 });
}

async function newThread(page: Page, text: string) {
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill(text);
  await composer.press('Enter');
  await page.waitForURL(/\/t\/thr_/);
  return composer;
}

test.describe('branching', () => {
  test.beforeEach(({ page }) => {
    test.skip(!BACKEND, 'needs Core (E2E_BACKEND=1)');
    return page.addInitScript(() => sessionStorage.setItem('nvx.ancile.setup-offered', '1'));
  });

  test('editing a question starts a new version, and both stay one click apart', async ({ page }) => {
    await newThread(page, '/say the first branch');
    await settled(page, 'the first branch');
    const q = questions(page).first();
    await q.hover();
    await q.getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('textbox', { name: 'Edit your message' });
    await edit.fill('/say the second branch');
    await page.getByRole('button', { name: 'Send edit' }).click();
    await settled(page, 'the second branch');
    const versions = questions(page).first().getByRole('group', { name: 'Versions of this message' });
    await expect(versions).toContainText('2 / 2');
    await versions.getByRole('button', { name: 'Previous version' }).click();
    await expect(versions).toContainText('1 / 2');
    await expect(answers(page).last()).toContainText('the first branch');
  });

  test('the tree shows both branches; compare, then merge into a new thread', async ({ page }) => {
    await newThread(page, '/say apples are red');
    await settled(page, 'apples are red');
    // A second version of the answer: a sibling branch.
    await answers(page).last().hover();
    await answers(page).last().getByRole('button', { name: 'Regenerate', exact: true }).click();
    await expect(answers(page).last().getByRole('group', { name: 'Versions of this message' })).toContainText(
      '2 / 2',
      { timeout: 15_000 },
    );
    await page.getByRole('tab', { name: /Branch tree|Tree/ }).click();
    const tree = page.getByRole('tree', { name: 'Branches in this thread' });
    await expect(tree).toBeVisible();
    await expect(tree.getByRole('treeitem')).toHaveCount(3, { timeout: 10_000 });
    // "You are here": the question and the newest reply.
    await expect(tree.locator('[role="treeitem"][aria-current="true"]')).toHaveCount(2);

    // Compare: from "you are here", h moves to the other reply and c compares.
    await tree.focus();
    await page.keyboard.press('h');
    await page.keyboard.press('c');
    const cmp = page.getByRole('dialog', { name: /Compare branches/ });
    await expect(cmp).toBeVisible({ timeout: 10_000 });
    await expect(cmp.getByRole('region', { name: 'How they differ' })).toBeVisible({ timeout: 15_000 });
    await cmp.getByRole('button', { name: 'Merge into a new thread' }).click();
    const merge = page.getByRole('dialog', { name: /Merge into a new thread/ });
    await expect(merge).toBeVisible();
    const create = merge.getByRole('button', { name: /Create merged thread/ });
    await expect(create).toBeEnabled({ timeout: 10_000 });
    const before = page.url();
    await create.click();
    await expect.poll(() => page.url(), { timeout: 20_000 }).not.toBe(before);
    await expect(page).toHaveURL(/\/t\/thr_/);
  });
});
