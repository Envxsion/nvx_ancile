/**
 * ------------------------------------------------------------------
 *  Title    |  Bundle budget
 *  Ref      |  ROADMAP P1
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Fail the build when the first download grows past what
 *           |  we agreed it may be.
 *  How      |  "First download" is the script the shell route needs to
 *           |  start: the entry named in dist/index.html plus every
 *           |  chunk it imports statically (dynamic import() is not
 *           |  counted; that is what the lazy routes and hosts are
 *           |  for). Raw bytes and gzip are both checked.
 *           |    node scripts/bundle-budget.mjs [dist-dir]
 *           |  runs after `vite build` (package.json "build").
 *  Note     |  Budgets are ratchets: lower them when a split lands,
 *           |  never raise one without saying why in the change.
 *           |  Measured 19 Oct 2026 after P1: 1,268 KB raw and 407 KB
 *           |  gzip (was 2,494 KB and 776 KB), budget +3%. The 900 KB
 *           |  goal is out of reach for now, and what remains is
 *           |  measured: React DOM 211 KB, zod 94 KB, the router and
 *           |  query 90 KB, Motion's core 77 KB, Radix and floating-ui
 *           |  about 100 KB (642 KB of packages in all); Core's
 *           |  contracts 85 KB; the sample-workspace fixtures 34 KB;
 *           |  the rest is the thread, composer, rail and shell that
 *           |  an idle thread needs. Next candidates: ToolSteps (25 KB,
 *           |  needs a sized placeholder per step) and loading the
 *           |  fixtures only in demo mode.
 * ------------------------------------------------------------------
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

/** The limits, in bytes. */
export const BUDGET = { raw: 1_306_000, gzip: 419_000 };

const STATIC_IMPORT = /(?:^|[;}\s,])(?:import|export)\s*(?:[^'"()]*?from\s*)?["']\.\/([^"']+\.js)["']/g;

/** The chunks the shell route needs before it can start, with their sizes. */
export function measureEntry(distDir) {
  const html = readFileSync(join(distDir, 'index.html'), 'utf8');
  const entry = /<script[^>]*type="module"[^>]*src="\/assets\/([^"]+\.js)"/.exec(html)?.[1];
  if (!entry) throw new Error(`No module script in ${join(distDir, 'index.html')}; build the Cockpit first.`);
  const queue = [entry];
  for (const m of html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="\/assets\/([^"]+\.js)"/g))
    queue.push(m[1]);
  const seen = new Set();
  const chunks = [];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const buf = readFileSync(join(distDir, 'assets', file));
    chunks.push({ file, raw: buf.length, gzip: gzipSync(buf).length });
    for (const m of buf.toString('utf8').matchAll(STATIC_IMPORT)) queue.push(m[1]);
  }
  chunks.sort((a, b) => b.raw - a.raw);
  return {
    entry,
    chunks,
    raw: chunks.reduce((n, c) => n + c.raw, 0),
    gzip: chunks.reduce((n, c) => n + c.gzip, 0),
  };
}

/** What is over budget, as sentences that say what to do. Empty when the build is within it. */
export function overBudget(measured, budget = BUDGET) {
  const kb = (n) => `${(n / 1000).toFixed(0)} KB`;
  const out = [];
  if (measured.raw > budget.raw)
    out.push(`The first download is ${kb(measured.raw)} raw; the budget is ${kb(budget.raw)}.`);
  if (measured.gzip > budget.gzip)
    out.push(`The first download is ${kb(measured.gzip)} gzipped; the budget is ${kb(budget.gzip)}.`);
  if (out.length)
    out.push(
      'Load the new code on demand (lazyRouteComponent, lazyHost, a dynamic import) or, if the growth is deliberate, say why and raise BUDGET in scripts/bundle-budget.mjs.',
    );
  return out;
}

function main() {
  const dist = process.argv[2] ?? 'dist';
  const m = measureEntry(dist);
  const kb = (n) => (n / 1000).toFixed(1).padStart(8);
  console.log(`First download (entry ${m.entry} and its static imports):`);
  for (const c of m.chunks) console.log(`  ${kb(c.raw)} KB raw ${kb(c.gzip)} KB gzip  ${c.file}`);
  console.log(
    `  ${kb(m.raw)} KB raw ${kb(m.gzip)} KB gzip  total (budget ${BUDGET.raw / 1000} / ${BUDGET.gzip / 1000})`,
  );
  const problems = overBudget(m);
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
