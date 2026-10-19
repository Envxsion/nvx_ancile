/**
 * ------------------------------------------------------------------
 *  Title    |  Long thread and long rail, measured
 *  Ref      |  ROADMAP P2, P3, P7
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Put numbers on what a long thread and a long rail cost
 *           |  the browser: DOM nodes, JS heap and rows drawn, after
 *           |  reading a thread from end to end.
 *  How      |  Start the Cockpit dev server (pnpm start, or
 *           |    pnpm --filter @nvx/ancile-cockpit dev
 *           |  ), then:
 *           |    node scripts/perf-long-thread.mjs [out-dir]
 *           |  Core's API is answered in the browser from a generated
 *           |  workspace (TURNS turns in one thread, RAIL threads in the
 *           |  rail), so nothing is written to a real workspace and no
 *           |  model is called. Heap is read after a forced collection.
 *           |  Env: COCKPIT_URL (default http://localhost:7701), TURNS
 *           |  (150), RAIL (1000), SHOTS=1 for screenshots at 1366x768
 *           |  and 768x1024 into out-dir/perf-*.png.
 *  Note     |  A dev aid, not a test: nothing here asserts a number.
 * ------------------------------------------------------------------
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? 'perf-shots';
const base = process.env.COCKPIT_URL ?? 'http://localhost:7701';
const TURNS = Number(process.env.TURNS ?? 150);
const RAIL = Number(process.env.RAIL ?? 1000);
const THREAD = 'thr_perf_long';
mkdirSync(out, { recursive: true });

const iso = (i) => new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
const PROSE = [
  '## What I found',
  '',
  'The importer now **pages** the transcript and the view draws only what is near. Each step is checked against the last one, and the notes below say what changed and why.',
  '',
  '- the first point, with a short reason',
  '- the second point, with `inline code` and a [link](https://example.com)',
  '- the third point',
  '',
  '```ts',
  ...Array.from({ length: 14 }, (_, i) => `export const value${i} = compute(${i}, "text ${i}");`),
  '```',
  '',
  'A closing paragraph that wraps over a couple of lines so the row has a believable height when it is drawn in full.',
].join('\n');

function wireMessages() {
  const msgs = [];
  for (let t = 0; t < TURNS; t++) {
    const u = t * 2;
    const base = (i, role, parts) => ({
      id: `m${i}`,
      thread_id: THREAD,
      parent_id: i ? `m${i - 1}` : null,
      role,
      model_id: role === 'assistant' ? 'offline/echo' : null,
      requested_model_id: null,
      status: 'complete',
      edit_of_id: null,
      provenance: {},
      usage: null,
      run_id: null,
      trace_id: '0'.repeat(32),
      created_at: iso(i),
      parts,
    });
    msgs.push(
      base(u, 'user', [
        { type: 'text', text: `Question ${t + 1}: how does the importer page a long transcript?` },
      ]),
    );
    msgs.push(base(u + 1, 'assistant', [{ type: 'text', text: `Answer ${t + 1}.\n\n${PROSE}` }]));
  }
  return msgs;
}

const MSGS = wireMessages();
const thread = (id, i) => ({
  id,
  title: id === THREAD ? 'A long thread' : `Thread ${i} about something worth finding again`,
  notebook_id: i % 5 === 0 ? `nb_${i % 4}` : null,
  active_head_id: null,
  settings: {},
  pinned_at: i < 4 ? iso(i) : null,
  archived_at: null,
  created_at: iso(0),
  updated_at: new Date(Date.UTC(2026, 9, 18) - i * 3_600_000).toISOString(),
});
const summaries = [
  { ...thread(THREAD, 0), branches: 1, live: false },
  ...Array.from({ length: RAIL - 1 }, (_, i) => ({
    ...thread(`thr_${i + 1}`, i + 1),
    branches: 1,
    live: false,
  })),
];
const notebooks = [0, 1, 2, 3].map((i) => ({
  id: `nb_${i}`,
  title: `Notebook ${i}`,
  description: '',
  icon: null,
  color: null,
  pinned: false,
  archived_at: null,
  grounded: false,
  counts: { sources: 0, threads: RAIL / 20 },
  created_at: iso(0),
  updated_at: iso(0),
}));

function answer(url) {
  const p = url.pathname.replace(/^\/api\/v1/, '');
  if (p === '/threads') return { items: summaries, next_cursor: null };
  const path = /^\/threads\/([^/]+)\/path$/.exec(p);
  if (path) {
    const limit = Number(url.searchParams.get('limit') ?? MSGS.length);
    const before = url.searchParams.get('before');
    const end = before ? MSGS.findIndex((m) => m.id === before) : MSGS.length;
    const start = Math.max(0, end - limit);
    return {
      thread: thread(path[1], 0),
      head_id: MSGS.at(-1).id,
      messages: MSGS.slice(start, end),
      active_run: null,
      total: MSGS.length,
      start,
      has_more: start > 0,
    };
  }
  if (p === '/notebooks') return { items: notebooks, next_cursor: null };
  if (p === '/setup') return { complete: true, preset: 'balanced', providers: [], offline_model: true };
  if (/^\/threads\/[^/]+$/.test(p)) return thread(p.split('/')[2], 0);
  if (p === '/repos/linked') return { repo: null };
  if (p.startsWith('/license')) return { features: [], build: 'free', edition: 'free' };
  return undefined;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await ctx.newPage();
await page.route('**/api/v1/**', (route) => {
  const url = new URL(route.request().url());
  if (route.request().method() !== 'GET')
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'x-trace-id': '0'.repeat(32) },
      body: '{}',
    });
  if (/\/(events|stream)/.test(url.pathname))
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'x-trace-id': '0'.repeat(32) },
      body: ': ready\n\n',
    });
  const body = answer(url);
  // Anything this script does not model is a plain "not found" in Core's own error shape.
  route.fulfill({
    status: body === undefined ? 404 : 200,
    contentType: 'application/json',
    headers: { 'x-trace-id': '0'.repeat(32) },
    body: JSON.stringify(
      body ?? {
        error: {
          code: 'perf.not_modelled',
          title: 'Not part of the perf workspace',
          hint: 'The perf script answers only the thread and rail.',
          retryable: false,
          trace_id: '0'.repeat(32),
        },
      },
    ),
  });
});
await page.addInitScript(() => {
  try {
    localStorage.setItem('nvx.ancile.core-seen', '1');
  } catch {}
});
if (process.env.DEBUG) {
  page.on(
    'console',
    (m) => ['error', 'warning'].includes(m.type()) && console.log('[console]', m.text().slice(0, 300)),
  );
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
}
const cdp = await ctx.newCDPSession(page);
await cdp.send('Performance.enable');

async function snap(label) {
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const get = (n) => metrics.find((m) => m.name === n)?.value ?? 0;
  const dom = await page.evaluate(() => ({
    nodes: document.querySelectorAll('*').length,
    drawn: document.querySelectorAll('.thread__messages > li .msg').length,
    placeholders: document.querySelectorAll('.thread__messages > li [data-lazy]').length,
    railNodes: document.querySelectorAll('.rail *').length,
    railRows: document.querySelectorAll('.rail a, .rail [role="treeitem"], .rail [data-thread]').length,
  }));
  console.log(
    `${label.padEnd(28)} heap ${(get('JSHeapUsedSize') / 1e6).toFixed(1).padStart(6)} MB  DOM ${String(dom.nodes).padStart(6)}  rail ${String(dom.railNodes).padStart(6)} nodes / ${dom.railRows} rows  thread rows drawn ${dom.drawn} placeholders ${dom.placeholders}`,
  );
  return dom;
}

const t0 = Date.now();
await page.goto(`${base}/t/${THREAD}`, { waitUntil: 'load' });
await page.waitForSelector('.thread__messages', { timeout: 30_000 });
await page.waitForTimeout(1800);
console.log(
  `opened in ${Date.now() - t0} ms (${TURNS} turns = ${MSGS.length} messages, rail ${RAIL} threads)`,
);
await snap('opened (last page)');

// Read the thread from end to end: up to the first message, then back down.
const scroll = async (dir) => {
  let last = -1;
  for (let i = 0; i < 2000; i++) {
    const done = await page.evaluate(
      ([d]) => {
        const el = document.querySelector('.thread__scroll');
        if (!el) return true;
        const before = el.scrollTop;
        el.scrollTop = d < 0 ? Math.max(0, before - 700) : before + 700;
        return el.scrollTop === before;
      },
      [dir],
    );
    await page.waitForTimeout(35);
    if (done) {
      if (last === i - 1 || dir > 0) break;
      last = i;
      await page.waitForTimeout(150);
    }
  }
};
await scroll(-1);
await page.waitForTimeout(500);
await scroll(-1);
await snap('read up to the first message');
await page.screenshot({ path: join(out, 'perf-thread-top-1366.png') });
await scroll(1);
await page.waitForTimeout(500);
await snap('back at the bottom');

if (process.env.SHOTS) {
  // The rail scrolled a long way down: rows are drawn where they are, not from the top.
  const deepRail = async (file) => {
    await page.evaluate(() => {
      const el = document.querySelector('.rail__scroll');
      if (el) el.scrollTop = el.scrollHeight * 0.55;
    });
    await page.waitForTimeout(600);
    await snap(`rail scrolled (${file})`);
    await page.screenshot({ path: join(out, file) });
  };
  await page.screenshot({ path: join(out, 'perf-thread-1366x768.png') });
  await deepRail('perf-rail-1366x768.png');
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, 'perf-thread-768x1024.png') });
  // Under 820 px the rail is an overlay: open it.
  const show = page.getByRole('button', { name: 'Show sidebar' });
  if (await show.count()) await show.first().click();
  await page.waitForTimeout(700);
  await deepRail('perf-rail-768x1024.png');
}

await browser.close();
