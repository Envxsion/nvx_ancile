/**
 * ------------------------------------------------------------------
 *  Title    |  Thread screenshots
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Photograph the demo Claude Code thread at desktop,
 *           |  narrow and phone widths, dark and light, so changes to
 *           |  the thread's layout can be judged by eye.
 *  How      |  Start the Cockpit in demo mode (Core unreachable):
 *           |    COCKPIT_PORT=7791 ANCILE_CORE_URL=http://127.0.0.1:9 \
 *           |      pnpm --filter @nvx/ancile-cockpit dev
 *           |  then: node scripts/shoot-thread.mjs <out-dir> [label]
 *           |  Each width is shot page by page down the thread; the
 *           |  "open" set expands every disclosure first.
 *  Note     |  A dev aid, not a test: nothing here asserts pixels.
 * ------------------------------------------------------------------
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? 'thread-shots';
const label = process.argv[3] ?? 'shot';
const base = process.env.COCKPIT_URL ?? 'http://localhost:7791';
const thread = process.env.THREAD_ID ?? 'thr_01J9ZK0000000000000000CCDE';
mkdirSync(out, { recursive: true });

const sets = [
  { name: 'd1440', width: 1440, height: 900, scheme: 'dark', pages: 6 },
  { name: 'd1440open', width: 1440, height: 900, scheme: 'dark', pages: 6, open: true },
  { name: 'l1440', width: 1440, height: 900, scheme: 'light', pages: 6 },
  { name: 'd900', width: 900, height: 900, scheme: 'dark', pages: 3 },
  { name: 'l420', width: 420, height: 860, scheme: 'light', pages: 3 },
];
const only = process.env.ONLY?.split(',');

const browser = await chromium.launch();
for (const set of sets) {
  if (only && !only.includes(set.name)) continue;
  const ctx = await browser.newContext({
    viewport: { width: set.width, height: set.height },
    colorScheme: set.scheme,
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  await page.goto(`${base}/t/${thread}`);
  await page.waitForSelector('.thread__messages', { timeout: 20_000 });
  await page.waitForTimeout(600);
  if (set.open)
    await page.evaluate(() => {
      for (const d of document.querySelectorAll('.thread__messages details')) d.open = true;
    });
  await page.waitForTimeout(200);
  const scroller = page.locator('.thread__scroll');
  const total = await scroller.evaluate((el) => el.scrollHeight);
  const step = set.height - 160;
  for (let i = 0; i < set.pages; i++) {
    const top = i * step;
    if (i > 0 && top >= total - 40) break;
    await scroller.evaluate((el, y) => {
      el.scrollTop = y;
    }, top);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, `${label}-${set.name}-${i + 1}.png`) });
  }
  await ctx.close();
}
await browser.close();
console.log(`saved to ${out}`);
