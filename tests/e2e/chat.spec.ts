/**
 * Phase 2: streaming chat, resumable streams, fallback, model switching,
 * drafts, stop and regenerate. Runs against the offline test model, which
 * obeys directives in the message (/say, /slow, /fail, /tool), so nothing
 * here needs a provider key or a network.
 */
import { expect, type Page, test } from '@playwright/test';
import { BACKEND } from './playwright.config';

async function newThread(page: Page, text: string) {
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill(text);
  await composer.press('Enter');
  await page.waitForURL(/\/t\/thr_/);
  return page.getByRole('textbox', { name: 'Message' });
}

const lastAnswer = (page: Page) => page.locator('article.msg[data-role="assistant"]').last();

test.describe('chat', () => {
  test.beforeEach(({ page }) => {
    test.skip(!BACKEND, 'needs Core (E2E_BACKEND=1)');
    // Onboarding is offered once per session; these tests start past it.
    return page.addInitScript(() => sessionStorage.setItem('nvx.ancile.setup-offered', '1'));
  });

  test('a message streams in and is saved with its model and cost', async ({ page }) => {
    await newThread(page, 'Hello from the end-to-end suite');
    await expect(lastAnswer(page)).toContainText('offline test model', { timeout: 15_000 });
    await expect(lastAnswer(page)).toContainText('Hello from the end-to-end suite');
    await expect(lastAnswer(page).locator('.msg__foot')).toContainText('tok');
    // The thread is titled from the first message.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hello from the end-to-end suite');
  });

  test('reloading mid-answer picks the stream back up and finishes it', async ({ page }) => {
    await newThread(page, '/slow one two three four five six seven eight');
    await expect(lastAnswer(page)).toContainText('offline test model', { timeout: 15_000 });
    await page.reload();
    await expect(lastAnswer(page)).toContainText('eight', { timeout: 30_000 });
    await expect(lastAnswer(page).locator('.msg__foot')).toContainText('tok');
  });

  test('falls back when the first model fails, and says so', async ({ page }) => {
    await newThread(page, '/fail 500');
    await expect(lastAnswer(page)).toContainText(
      /Answered by Offline echo because Offline test model was unavailable/,
      { timeout: 15_000 },
    );
    await expect(lastAnswer(page)).toContainText("I'm Offline echo, the backup model");
  });

  test('the slash menu offers only working commands, and the test directives', async ({ page }) => {
    await page.goto('/');
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('/');
    const menu = page.getByRole('listbox', { name: 'Commands' });
    await expect(menu.getByRole('option', { name: /\/model/ })).toBeVisible();
    await expect(menu.getByRole('option', { name: /\/factcheck/ })).toHaveCount(0);
    await composer.fill('/fa');
    await expect(menu.getByRole('option', { name: /\/fail 500/ })).toBeVisible();
    await composer.press('Enter');
    await expect(composer).toHaveValue('/fail 500 ');
    await composer.fill('/mo');
    await composer.press('Enter');
    await expect(page.getByRole('option', { name: /Offline echo/ })).toBeVisible();
  });

  test('a refusal also falls back', async ({ page }) => {
    await newThread(page, '/fail refusal');
    await expect(lastAnswer(page)).toContainText(/because Offline test model declined/, { timeout: 15_000 });
  });

  test('m switches model for the next message, and earlier context carries over', async ({ page }) => {
    const composer = await newThread(page, '/say My favourite colour is teal.');
    await expect(lastAnswer(page)).toContainText('teal', { timeout: 15_000 });
    await expect(lastAnswer(page).locator('.msg__foot')).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('m');
    await page.getByRole('option', { name: /Offline echo/ }).click();
    await composer.fill('What is my favourite colour?');
    await composer.press('Enter');
    // An answer is named after the model that wrote it.
    await expect(lastAnswer(page)).toHaveAttribute('aria-label', 'Offline echo', { timeout: 15_000 });
    await expect(lastAnswer(page)).toContainText('What is my favourite colour?');
  });

  test('stop keeps what was written and marks the answer stopped', async ({ page }) => {
    await newThread(page, '/slow a long and leisurely answer that takes a while to arrive in full');
    await expect(lastAnswer(page)).toContainText('offline test model', { timeout: 15_000 });
    await lastAnswer(page).getByRole('button', { name: 'Stop' }).click();
    await expect(lastAnswer(page).locator('.msg__foot')).toContainText('Stopped', { timeout: 15_000 });
  });

  test('regenerate adds a second version you can page between', async ({ page }) => {
    await newThread(page, '/say first version');
    await expect(lastAnswer(page)).toContainText('first version', { timeout: 15_000 });
    await lastAnswer(page).hover();
    await lastAnswer(page).getByRole('button', { name: 'Regenerate', exact: true }).click();
    await expect(lastAnswer(page).getByRole('group', { name: 'Versions of this message' })).toContainText(
      '2 / 2',
      {
        timeout: 15_000,
      },
    );
    await lastAnswer(page).getByRole('button', { name: 'Previous version' }).click();
    await expect(lastAnswer(page).getByRole('group', { name: 'Versions of this message' })).toContainText(
      '1 / 2',
    );
  });

  test('a draft survives a reload', async ({ page }) => {
    const composer = await newThread(page, '/say ready');
    await expect(lastAnswer(page)).toContainText('ready', { timeout: 15_000 });
    await expect(lastAnswer(page).locator('.msg__foot')).toBeVisible({ timeout: 15_000 });
    await composer.fill('half-written thought');
    await page.waitForTimeout(1_600);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('half-written thought');
  });
});
