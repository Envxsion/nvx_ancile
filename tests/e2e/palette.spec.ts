/**
 * Phase 1–2: the command palette and keyboard-first navigation.
 */
import { expect, test } from '@playwright/test';
import { expectAccessible, mod, openPalette, resolvedTheme } from './fixtures';
import { BACKEND } from './playwright.config';

test.describe('command palette', () => {
  test('Ctrl/Cmd+K opens it with the search field focused; Esc closes it', async ({ page }) => {
    await page.goto('/');
    const palette = await openPalette(page);
    await expect(palette.getByRole('combobox')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  });

  test('fuzzy search finds commands and runs one with Enter', async ({ page }) => {
    await page.goto('/');
    const before = await resolvedTheme(page);
    const palette = await openPalette(page);
    await page.keyboard.type('thme');
    const option = palette.getByRole('option', { name: /theme/i }).first();
    await expect(option).toBeVisible();
    await page.keyboard.press('Enter');
    // Either the theme flips directly or a submenu offers the choices.
    const sub = palette.getByRole('option', { name: before === 'dark' ? /light/i : /dark/i });
    if (await sub.isVisible().catch(() => false)) await page.keyboard.press('Enter');
    await expect.poll(() => resolvedTheme(page)).not.toBe(before);
  });

  test('arrow keys move the selection', async ({ page }) => {
    await page.goto('/');
    const palette = await openPalette(page);
    const options = palette.getByRole('option');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  });

  test('is accessible while open', async ({ page }) => {
    await page.goto('/');
    await openPalette(page);
    await expectAccessible(page);
  });

  test('? shows the shortcut sheet', async ({ page }) => {
    await page.goto('/');
    // Clear focus rather than clicking: a click in the middle of the page can
    // land in the composer, where "?" is text, as it should be.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Shift+Slash');
    await expect(page.getByRole('dialog', { name: /shortcuts/i })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('switch model from the palette', async ({ page }) => {
    test.skip(!BACKEND, 'needs Core /models (E2E_BACKEND=1)');
    await page.addInitScript(() => sessionStorage.setItem('nvx.ancile.setup-offered', '1'));
    await page.goto('/');
    const palette = await openPalette(page);
    await page.keyboard.type('@echo');
    await palette.getByRole('option', { name: /Offline echo/ }).click();
    await expect(
      page.getByRole('contentinfo').getByRole('button', { name: /Model: Offline echo/ }),
    ).toBeVisible();
  });

  test('single-key shortcuts are inactive while typing', async ({ page }) => {
    await page.goto('/');
    const composer = page.getByRole('textbox').first();
    test.skip(!(await composer.isVisible().catch(() => false)), 'no composer on this route yet');
    await composer.click();
    await page.keyboard.type('jk?');
    await expect(composer).toHaveValue(/jk\?/);
    await expect(page.getByRole('dialog', { name: /shortcuts/i })).toBeHidden();
    await page.keyboard.press(`${mod}+k`);
    await expect(page.getByRole('dialog', { name: /command/i })).toBeVisible();
  });
});
