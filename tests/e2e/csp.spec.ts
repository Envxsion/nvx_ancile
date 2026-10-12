/**
 * The Cockpit's Content Security Policy (packages/contracts/src/csp.ts,
 * docs/desktop.md): every route works under it, in its demo data, with not
 * one violation reported, and the policy is the strict one (no inline
 * script but our own hashed one, connections to this origin only).
 */
import { expect, type Page, test } from '@playwright/test';
import { DEMO_ROUTES, DEMO_THREAD } from './fixtures';
import { BACKEND } from './playwright.config';

declare global {
  interface Window {
    __csp: string[];
  }
}

async function watch(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem('nvx.ancile.setup-offered', '1');
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`),
    );
  });
}

test.describe('content security policy', () => {
  test.skip(BACKEND, 'runs on the demo data');
  test.beforeEach(async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium-dark', 'once, on desktop Chromium');
    await watch(page);
  });

  test('the page carries the strict policy and the header narrows frames to the frame host', async ({
    page,
  }) => {
    const res = await page.goto('/');
    const header = res?.headers()['content-security-policy'] ?? '';
    expect(header).toContain("frame-ancestors 'none'");
    expect(header).toMatch(/frame-src http:\/\/[^ ;]+\/frame\.html/);
    const meta = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(meta).toContain("default-src 'self'");
    expect(meta).toMatch(/script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')+;/);
    expect(meta).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(meta).toContain("connect-src 'self';");
    expect(meta).toContain("object-src 'none'");
    expect(meta).toContain("base-uri 'none'");
    expect(meta).toContain("form-action 'none'");
  });

  for (const route of DEMO_ROUTES)
    test(`${route} works with no violation`, async ({ page }) => {
      await page.goto(route);
      await page.waitForLoadState('load');
      await expect(page.getByRole('main')).toBeVisible();
      await page.waitForTimeout(400);
      expect(await page.evaluate(() => window.__csp)).toEqual([]);
    });

  test('an inline script injected into the page does not run', async ({ page }) => {
    await page.goto(`/t/${DEMO_THREAD}`);
    await expect(page.getByRole('main')).toBeVisible();
    const ran = await page.evaluate(async () => {
      const w = window as unknown as { __injected?: boolean };
      const s = document.createElement('script');
      s.textContent = 'window.__injected = true';
      document.body.appendChild(s);
      const img = document.createElement('img');
      img.setAttribute('onerror', 'window.__injected = true');
      img.src = 'data:,x';
      document.body.appendChild(img);
      await new Promise((r) => setTimeout(r, 200));
      return Boolean(w.__injected);
    });
    expect(ran).toBe(false);
    expect((await page.evaluate(() => window.__csp)).some((v) => v.startsWith('script-src'))).toBe(true);
  });
});
