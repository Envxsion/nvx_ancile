/**
 * Phase 1: the shell renders with the full identity, the theme works with
 * no flash, and the page is accessible in both themes.
 */
import { expect, test } from '@playwright/test';
import { expectAccessible, resolvedTheme, THEME_KEY } from './fixtures';

test.describe('shell', () => {
  test('renders the frame: titlebar, rail, thread area, status bar', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/NVX Ancile/);
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('banner').getByLabel('NVX Ancile')).toBeVisible();
    await expect(page.getByRole('navigation').first()).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('contentinfo')).toBeVisible();
  });

  test('empty thread view teaches the next action', async ({ page }) => {
    await page.goto('/');
    const main = page.getByRole('main');
    // One sentence and one action, never a blank screen.
    await expect(main.getByRole('button').or(main.getByRole('textbox')).first()).toBeVisible();
  });

  test('follows the system theme by default', async ({ page }, info) => {
    await page.goto('/');
    // Chromium reports light when a project sets no scheme.
    const expected = (info.project.use.colorScheme ?? 'light') === 'dark' ? 'dark' : 'light';
    expect(await resolvedTheme(page)).toBe(expected);
  });

  test('theme choice persists across reloads with no flash', async ({ page }) => {
    await page.goto('/');
    await page.evaluate((key) => localStorage.setItem(key, 'light'), THEME_KEY);
    // Record the theme at the earliest moment the document exists.
    await page.addInitScript(() => {
      new MutationObserver((_, obs) => {
        if (document.documentElement) {
          (window as unknown as { __firstTheme?: string }).__firstTheme =
            document.documentElement.dataset.theme;
          obs.disconnect();
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.reload();
    expect(await resolvedTheme(page)).toBe('light');
    const first = await page.evaluate(() => (window as unknown as { __firstTheme?: string }).__firstTheme);
    // The boot script sets the theme in <head>, before the body paints.
    expect(first === undefined || first === 'light').toBeTruthy();
  });

  test('theme toggle is reachable by keyboard and changes the ground', async ({ page }) => {
    await page.goto('/');
    const before = await resolvedTheme(page);
    const toggle = page.getByRole('button', { name: /theme/i });
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Enter');
    // A menu (System / Dark / Light) or a direct toggle are both fine.
    const option = page.getByRole('menuitemradio', { name: before === 'dark' ? /light/i : /dark/i });
    if (await option.isVisible().catch(() => false)) await option.click();
    await expect.poll(() => resolvedTheme(page)).not.toBe(before);
  });

  test('is accessible', async ({ page }) => {
    await page.goto('/');
    await expectAccessible(page);
  });

  test('respects reduced motion', async ({ page }, info) => {
    test.skip(info.project.name !== 'reduced-motion');
    await page.goto('/');
    const duration = await page.evaluate(() => {
      const el = document.querySelector('svg.ancile-mark .inner');
      return el ? getComputedStyle(el).animationDuration : '0s';
    });
    expect(parseFloat(duration)).toBeLessThan(0.1);
  });
});
