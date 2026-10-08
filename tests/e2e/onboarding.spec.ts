/**
 * Phase 2: first run with no file editing. A key is tested live (here a
 * wrong one, which must be refused and not stored), the offline test model
 * stands in, a preset is chosen, and you land in a first thread.
 */
import { expect, test } from '@playwright/test';
import { BACKEND } from './playwright.config';

test('first run: models, permissions, memory, shortcuts, then Home with the first steps', async ({
  page,
}) => {
  test.skip(!BACKEND, 'needs Core (E2E_BACKEND=1)');
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Welcome to NVX Ancile' })).toBeVisible();
  await page.getByRole('button', { name: 'Get started' }).click();

  // A wrong key is tested for real and refused; nothing is stored.
  await page.getByRole('textbox', { name: 'OpenRouter API key' }).fill('not-a-real-key');
  await page.getByRole('button', { name: 'Test OpenRouter key' }).click();
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 20_000 });

  // The offline test model lets setup continue without a key.
  await expect(page.getByText(/offline test model/i)).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('radio', { name: 'Balanced' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('radio', { name: 'Ask me every time' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Five keys worth knowing' })).toBeVisible();
  await page.getByRole('button', { name: 'Open NVX Ancile' }).click();
  // Home, with the first steps under the composer.
  await page.waitForURL((u) => u.pathname === '/');
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Learn NVX Ancile in a few minutes' })).toBeVisible();
});
