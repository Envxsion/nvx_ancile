/**
 * Images in a thread (docs/images.md), on the real components
 * (apps/cockpit/testbed/images.html, under the app's image CSP): every
 * image draws inline with its alt text; a remote image is never requested
 * from its site, before or after the person allows it (it comes through
 * Core's proxy); the lightbox is a dialog that passes axe and closes on
 * Escape; the page passes axe in both themes. Needs no backend: Core's
 * image routes are answered here.
 */
import { expect, test } from '@playwright/test';
import { expectAccessible } from './fixtures';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('images in a thread', () => {
  test('draws every image, asks before a remote one, loads it through Core, and passes axe', async ({
    page,
  }) => {
    const remote: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('tracker.example') && !r.url().includes('/api/v1/')) remote.push(r.url());
    });
    // Playwright tries the newest route first: the catch-all goes first.
    await page.route('**/api/v1/**', (r) =>
      r.fulfill({ status: 404, json: { error: { code: 'request.not_found' } } }),
    );
    let allowed: string[] = [];
    await page.route('**/api/v1/threads/thr_testbed/image-hosts', (r) => {
      if (r.request().method() === 'POST') allowed = [...allowed, 'tracker.example'];
      return r.fulfill({ json: { remembered_in: 'notebook', hosts: allowed, allowed: true } });
    });
    await page.route('**/api/v1/threads/thr_testbed/images/remote?**', (r) =>
      r.fulfill({ body: PNG, contentType: 'image/png' }),
    );
    await page.goto('/testbed/images.html');

    await expect(page.getByRole('img', { name: 'Site photo, north gate' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Mean load by hour, peaking at 06:00' })).toBeVisible();
    await expect(page.getByRole('img', { name: /The Kingsford depot at dusk/ }).first()).toBeVisible();
    await expect(page.getByText('Making the image')).toBeVisible();
    const load = page.getByRole('button', { name: 'Load image from tracker.example' });
    await expect(load).toBeVisible();
    await expect(page.getByRole('img', { name: 'Aerial view of the depot' })).toHaveCount(0);
    await expectAccessible(page);

    await load.click();
    const aerial = page.getByRole('img', { name: 'Aerial view of the depot' });
    await expect(aerial).toBeVisible();
    expect(await aerial.getAttribute('src')).toMatch(
      /^\/api\/v1\/threads\/thr_testbed\/images\/remote\?url=/,
    );
    expect(remote, 'no request reaches the remote site').toEqual([]);
  });

  test('the lightbox is a named dialog with zoom, copy and download, and closes on Escape', async ({
    page,
  }) => {
    await page.route('**/api/v1/**', (r) =>
      r.fulfill({ json: { remembered_in: 'notebook', hosts: [], allowed: true } }),
    );
    await page.goto('/testbed/images.html');
    const open = page.getByRole('button', { name: 'Open image: Site photo, north gate' });
    await open.click();
    const dialog = page.getByRole('dialog', { name: 'Site photo, north gate' });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    for (const name of ['Zoom in', 'Zoom out', 'Copy image'])
      await expect(dialog.getByRole('button', { name })).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Download image' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Zoom in' }).click();
    await expect(dialog.getByText('150%')).toBeVisible();
    await expectAccessible(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();
  });
});
