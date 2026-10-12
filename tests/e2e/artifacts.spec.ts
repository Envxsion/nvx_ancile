/**
 * Artifacts cannot get out (docs/artifacts.md, nvx_folio's conditions).
 *
 * The real ArtifactFrame (apps/cockpit/testbed/artifact.html) runs a probe
 * artifact that tries every way out: fetch, XHR, a WebSocket, images, CSS,
 * prefetch, beacons, EventSource, scripts, nested frames, workers, forms,
 * popups, top and self navigation, storage, cookies and the parent's DOM.
 * A local HTTP server stands in for Core on 127.0.0.1 and counts every hit.
 *
 * Proven: zero hits with the network off; zero hits on 127.0.0.1 even with
 * the network allowed (https only); nothing of the parent readable; the
 * frame's origin is opaque. A control request from the page itself does
 * reach the server, so the zero is meaningful.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Page, test } from '@playwright/test';
import { BACKEND } from './playwright.config';

let server: Server;
let port = 0;
const hits: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(new URL(req.url ?? '/', 'http://x').searchParams.get('k') ?? req.url ?? '?');
    res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' });
    res.end('hit');
  });
  // WebSocket upgrades count too.
  server.on('upgrade', (req, socket) => {
    hits.push(`upgrade:${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function probe(page: Page, net: boolean): Promise<Record<string, string>> {
  await page.goto(`/testbed/artifact.html?port=${port}${net ? '&net=1' : ''}`);
  const report = page.locator('#report');
  await expect(report).toBeAttached({ timeout: 30_000 });
  const r = JSON.parse((await report.textContent()) ?? '{}') as Record<string, string>;
  // Give the frame's last move (navigating itself) time to land, if it could.
  await page.waitForTimeout(1_200);
  return r;
}

test.describe('artifact sandbox', () => {
  test.skip(BACKEND, 'runs on the dev server only');
  test.skip(({ browserName }) => browserName !== 'chromium', 'the sandbox rules are checked in Chromium');

  test('a request from the page itself reaches the stand-in server (control)', async ({ page }) => {
    hits.length = 0;
    await page.goto('/testbed/artifact.html?port=9');
    await page.evaluate(async (p) => {
      await fetch(`http://127.0.0.1:${p}/hit?k=control`, { mode: 'no-cors' });
    }, port);
    expect(hits).toContain('control');
  });

  test('with the network off nothing leaves the frame and nothing of the parent is readable', async ({
    page,
  }) => {
    hits.length = 0;
    const seen: string[] = [];
    // Chromium reports a request the CSP stops as started then failed: none may get an answer.
    page.on('response', (res) => {
      if (res.url().includes(`127.0.0.1:${port}`)) seen.push(res.url());
    });
    const r = await probe(page, false);
    expect(hits, `hits on the stand-in server: ${hits.join(', ')}`).toEqual([]);
    expect(seen, 'responses from the stand-in server').toEqual([]);
    for (const k of ['fetch', 'fetch_https', 'xhr', 'websocket', 'image', 'eventsource', 'script'])
      expect(r[k], k).toMatch(/^blocked/);
    expect(r.rtc).toBe('absent');
    expect(r.local_storage).toMatch(/^blocked/);
    expect(r.cookie).toMatch(/^blocked/);
    expect(r.parent_dom).toMatch(/^blocked/);
    expect(r.parent_storage).toMatch(/^blocked/);
    expect(r.top_navigation).toMatch(/^blocked/);
    expect(r.popup).toMatch(/^blocked/);
    expect(r.origin).toBe('origin: null');
    // The page itself is still where it was.
    expect(new URL(page.url()).pathname).toBe('/testbed/artifact.html');
  });

  test('with the network allowed, 127.0.0.1 (and so Core) is still out of reach', async ({ page }) => {
    hits.length = 0;
    const r = await probe(page, true);
    expect(hits, `hits on the stand-in server: ${hits.join(', ')}`).toEqual([]);
    for (const k of ['fetch', 'xhr', 'websocket', 'image', 'script']) expect(r[k], k).toMatch(/^blocked/);
    expect(r.local_storage).toMatch(/^blocked/);
    expect(r.parent_dom).toMatch(/^blocked/);
  });

  test('React, SVG and Mermaid artifacts draw inside the sandbox', async ({ page }) => {
    await page.goto('/testbed/artifact.html?type=react');
    const react = page.frameLocator('iframe[title="Probe"]');
    await expect(react.locator('#b')).toHaveText('Count 2', { timeout: 30_000 });
    await react.locator('#b').click();
    await expect(react.locator('#b')).toHaveText('Count 3');

    await page.goto('/testbed/artifact.html?type=svg');
    await expect(page.frameLocator('iframe[title="Probe"]').locator('circle')).toBeAttached();

    await page.goto('/testbed/artifact.html?type=mermaid');
    await expect(page.frameLocator('iframe[title="Probe"]').locator('#ancile-root svg')).toBeAttached({
      timeout: 30_000,
    });
  });

  test('the frame carries only allow-scripts', async ({ page }) => {
    await page.goto('/testbed/artifact.html?type=svg');
    const frame = page.locator('iframe[title="Probe"]');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  });
});
