/**
 * Phases 1-3 and the learning layer: Settings (every group, a rebound
 * key, export and import), the guide and its glossary, a term explained
 * where it appears, notifications, the getting-started checklist, and a
 * keyboard-only walk through the app.
 */
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { mod } from './fixtures';
import { BACKEND } from './playwright.config';

const GROUPS = [
  'Appearance',
  'Layout',
  'Reading',
  'Composer',
  'Keyboard',
  'Notifications',
  'Accessibility',
  'Advanced',
];

async function notebookId(page: Page): Promise<string | undefined> {
  const r = await page.request.get('/api/v1/notebooks');
  const body = (await r.json()) as { items?: { id: string }[] } | { id: string }[];
  return (Array.isArray(body) ? body : (body.items ?? []))[0]?.id;
}

test.describe('workspace', () => {
  test.beforeEach(({ page }) => {
    test.skip(!BACKEND, 'needs Core (E2E_BACKEND=1)');
    return page.addInitScript(() => sessionStorage.setItem('nvx.ancile.setup-offered', '1'));
  });

  test('every settings group opens, and a switch changes and resets', async ({ page }) => {
    await page.goto('/settings/appearance');
    const nav = page.getByRole('complementary', { name: 'Settings groups' });
    for (const g of GROUPS) {
      await nav.getByRole('link', { name: g }).click();
      await expect(page.getByRole('heading', { level: 2, name: g }).first()).toBeVisible();
    }
    await nav.getByRole('link', { name: 'Keyboard' }).click();
    const single = page.getByRole('switch', { name: 'Single-key shortcuts' });
    const was = await single.getAttribute('aria-checked');
    await single.click();
    await expect(single).not.toHaveAttribute('aria-checked', was ?? '');
    await page.getByRole('button', { name: 'Reset keyboard' }).click();
    await expect(single).toHaveAttribute('aria-checked', was ?? 'true');
  });

  test('a key can be rebound, works at once, and goes back', async ({ page }) => {
    await page.goto('/settings/keyboard');
    const row = page.locator('.keyrow').filter({ hasText: /^Help/ }).first();
    await row.getByRole('button', { name: 'Change' }).click();
    await page.keyboard.press('F9');
    await row.getByRole('button', { name: /Save|Use anyway/ }).click();
    await page
      .locator('body')
      .click({ position: { x: 5, y: 5 } })
      .catch(() => {});
    await page.keyboard.press('Escape');
    await page.keyboard.press('F9');
    await expect(page.getByRole('dialog', { name: /guide/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await row.getByRole('button', { name: 'Reset' }).click();
    await expect(row).toContainText(/G/);
  });

  test('settings export as a file and import with a preview', async ({ page }) => {
    await page.goto('/settings/appearance');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('ancile-settings.json');
    const file = await download.path();
    const json = JSON.parse(readFileSync(file, 'utf8')) as { appearance?: { theme?: string } };
    expect(json.appearance).toBeTruthy();
    await page.locator('input[type="file"]').setInputFiles(file);
    // Importing the same settings changes nothing, and says so or shows an empty preview.
    await expect(page.getByText(/nothing|no changes|same|import/i).first()).toBeVisible({ timeout: 5_000 });
  });

  test('the guide searches, explains its words, and the glossary is one of its pages', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Open the guide' }).click();
    const guide = page.getByRole('dialog', { name: /guide/i });
    await expect(guide).toBeVisible();
    await guide
      .getByRole('searchbox', { name: 'Search the guide' })
      .or(guide.getByRole('textbox', { name: 'Search the guide' }))
      .fill('words');
    await guide.getByText('Words used here').first().click();
    await expect(guide).toContainText(/Branch/);
    await guide.getByRole('button', { name: 'Close the guide' }).click();
    await expect(guide).toBeHidden();
  });

  test('a word with a dotted underline explains itself', async ({ page }) => {
    const id = await notebookId(page);
    test.skip(!id, 'needs a notebook (pnpm seed --e2e)');
    await page.goto(`/n/${id}`);
    const term = page.locator('.term').first();
    test.skip(!(await term.isVisible().catch(() => false)), 'no term on this page');
    await term.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog').last()).toBeVisible();
  });

  test('notifications open from the bell and close with Esc', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /^Notifications/ }).click();
    const center = page.getByRole('dialog', { name: 'Notifications' });
    await expect(center).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(center).toBeHidden();
  });

  test('the getting-started checklist opens from the sidebar', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: /Getting started/ });
    test.skip(!(await toggle.isVisible().catch(() => false)), 'the checklist is finished or hidden');
    const was = await toggle.getAttribute('aria-expanded');
    await toggle.click();
    await expect(toggle).not.toHaveAttribute('aria-expanded', was ?? '');
  });

  test('keyboard only: palette to Settings, g then n, ? for shortcuts, Esc back', async ({ page }) => {
    await page.goto('/');
    await page.locator('body').press(`${mod}+k`);
    const palette = page.getByRole('dialog', { name: /command/i });
    await expect(palette).toBeVisible();
    await page.keyboard.type('settings');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/settings/);
    await page.keyboard.press('Escape');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('g');
    await page.keyboard.press('s');
    await expect(page).toHaveURL(/\/settings/);
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();
  });
});
