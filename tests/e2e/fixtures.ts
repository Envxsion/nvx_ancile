/**
 * Shared helpers. Selectors use roles and accessible names only, so they
 * double as an accessibility check: if a test can't find a control by
 * its name, a screen reader can't either.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const THEME_KEY = 'nvx.ancile.theme';
export const isMac = process.platform === 'darwin';
export const mod = isMac ? 'Meta' : 'Control';

/** No serious or critical axe violations on the current page. */
export async function expectAccessible(page: Page, exclude: string[] = []) {
  // Measure settled colours: a theme cross-fade mid-way reads as low contrast.
  await page.addStyleTag({
    content: '*,*::before,*::after{transition:none!important;animation:none!important}',
  });
  // Script-driven animations (Motion's fades) are not stopped by CSS: wait them out.
  await page
    .waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, {
      timeout: 3_000,
    })
    .catch(() => {});
  await page.waitForTimeout(150);
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  for (const sel of exclude) builder = builder.exclude(sel);
  const { violations } = await builder.analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious,
    serious
      .map(
        (v) =>
          `${v.id}: ${v.help} at ${v.nodes
            .map((n) => n.target.join(' '))
            .slice(0, 4)
            .join(', ')}`,
      )
      .join('\n'),
  ).toEqual([]);
}

export async function openPalette(page: Page) {
  await page.keyboard.press(`${mod}+k`);
  const palette = page.getByRole('dialog', { name: /command/i });
  await expect(palette).toBeVisible();
  return palette;
}

export async function resolvedTheme(page: Page) {
  return page.evaluate(() => document.documentElement.dataset.theme);
}
