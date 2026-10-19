/**
 * ------------------------------------------------------------------
 *  Title    |  Graph layout, timed on the page
 *  Ref      |  ROADMAP P4
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  How long a big graph's layout holds the page, on the
 *           |  main thread (how it used to run) and in the worker.
 *  How      |  With the dev server up (pnpm start):
 *           |    node scripts/perf-layout.mjs
 *           |  lays out a generated graph (NODES, default 500) both
 *           |  ways in the real browser, with a 60 Hz ticker on the
 *           |  page. "Longest frame gap" is the longest time the page
 *           |  could not run that ticker: the freeze a person feels.
 *           |  Env: COCKPIT_URL (default http://localhost:7701).
 *  Note     |  A dev aid, not a test: nothing here asserts a number.
 * ------------------------------------------------------------------
 */

import { chromium } from '@playwright/test';

const base = process.env.COCKPIT_URL ?? 'http://localhost:7701';
const NODES = Number(process.env.NODES ?? 500);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base, { waitUntil: 'load' });

// The first import can make the dev server re-optimise its dependencies and reload the page: go again.
async function measure(attempt = 0) {
  try {
    return await run();
  } catch (e) {
    if (attempt >= 3 || !/context was destroyed|navigation/.test(String(e))) throw e;
    await page.waitForLoadState('load');
    await page.waitForTimeout(1500);
    return measure(attempt + 1);
  }
}

const run = () =>
  page.evaluate(
    async ({ nodes }) => {
      const m = await import('/src/lib/elk.ts');
      // A flow-like graph: a spine with branches that rejoin.
      const children = Array.from({ length: nodes }, (_, i) => ({ id: `n${i}`, width: 220, height: 72 }));
      const edges = [];
      for (let i = 1; i < nodes; i++) {
        edges.push({ id: `e${i}`, sources: [`n${Math.floor((i - 1) / 2)}`], targets: [`n${i}`] });
        if (i % 7 === 0 && i > 10) edges.push({ id: `x${i}`, sources: [`n${i - 9}`], targets: [`n${i}`] });
      }
      const graph = () => ({
        id: 'root',
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': 'RIGHT',
          'elk.layered.spacing.nodeNodeBetweenLayers': '96',
          'elk.spacing.nodeNode': '40',
          'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
          'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
          'elk.edgeRouting': 'SPLINES',
        },
        children: children.map((c) => ({ ...c })),
        edges: edges.map((e) => ({ ...e })),
      });

      async function time(layout) {
        let worst = 0;
        let last = performance.now();
        let stop = false;
        const tick = () => {
          const now = performance.now();
          worst = Math.max(worst, now - last);
          last = now;
          if (!stop) setTimeout(tick, 16);
        };
        setTimeout(tick, 16);
        const t0 = performance.now();
        const out = await layout(graph());
        const total = performance.now() - t0;
        stop = true;
        await new Promise((r) => setTimeout(r, 40));
        return {
          total: Math.round(total),
          longestFrameGap: Math.round(worst),
          placed: out.children?.length ?? 0,
        };
      }

      const main = await m.onMainThread();
      const worker = await m.inWorker();
      // Warm both (module load, worker start), then measure.
      await main({ id: 'w', children: [{ id: 'a', width: 1, height: 1 }], edges: [] });
      await worker({ id: 'w', children: [{ id: 'a', width: 1, height: 1 }], edges: [] });
      return { mainThread: await time(main), worker: await time(worker) };
    },
    { nodes: NODES },
  );
const result = await measure();

console.log(`${NODES}-node layout:`);
console.log('  main thread (before):', result.mainThread);
console.log('  web worker  (after): ', result.worker);
await browser.close();
