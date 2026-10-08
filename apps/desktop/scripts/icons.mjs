#!/usr/bin/env node
/**
 * ------------------------------------------------------------------
 *  Title    |  Desktop icons
 *  ID       |  desktop
 * ------------------------------------------------------------------
 *  Purpose  |  Every app icon (ico, icns, png sizes) from the one
 *           |  family app-icon drawing the Cockpit already ships, so
 *           |  the window, the tray and the installer never drift.
 *  How      |  Renders apps/cockpit/public/icon-128.svg at 1024 px with
 *           |  Playwright (already a dev dependency), then hands the PNG
 *           |  to `tauri icon`. Run after changing the drawing.
 * ------------------------------------------------------------------
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const svg = readFileSync(join(root, 'apps', 'cockpit', 'public', 'icon-128.svg'), 'utf8');
const out = join(here, '..', 'src-tauri', 'app-icon.png');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
// The drawing is 128 units with a 96-unit squircle; scale it so the squircle
// fills the canvas as an app icon should, keeping a little room for its edge.
const sized = svg.replace(
  'width="128" height="128" viewBox="0 0 128 128"',
  'width="1024" height="1024" viewBox="14 14 100 100"',
);
await page.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`);
await page.locator('svg').screenshot({ path: out, omitBackground: true });
await browser.close();

execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['tauri', 'icon', out], {
  cwd: join(here, '..'),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
