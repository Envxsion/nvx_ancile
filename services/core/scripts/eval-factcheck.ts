/**
 * ------------------------------------------------------------------
 *  Title    |  Fact-check eval: verdicts and citations, offline
 *  Ref      |  tests/eval/README.md (factcheck/) · src/factcheck/evals.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Run the labelled claims in tests/eval/factcheck through
 *           |  the real verifier step and score with the offline test
 *           |  models, print the numbers, and fail when any is under
 *           |  the floor in thresholds.json. CI runs it as a blocking
 *           |  job; nothing here calls a network or a paid model.
 *  How      |  `pnpm --filter @nvx/ancile-core eval:factcheck`
 *           |  [--json] [--report <file>] [--show-misses]
 * ------------------------------------------------------------------
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadEvalFixtures,
  missedThresholds,
  offlineEvalDeps,
  runFactcheckEval,
} from '../src/factcheck/evals';

const ROOT = join(import.meta.dirname, '../../..');
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const fixtures = await loadEvalFixtures(join(ROOT, 'tests/eval/factcheck'));
const deps = await offlineEvalDeps(join(ROOT, 'prompts'));
const report = await runFactcheckEval(deps, fixtures);
const missed = missedThresholds(report, fixtures.thresholds);

const report_path = value('--report');
if (report_path)
  await writeFile(
    report_path,
    `${JSON.stringify({ ...report, thresholds: fixtures.thresholds, missed }, null, 2)}\n`,
  );

if (flag('--json')) {
  const { results: _r, ...summary } = report;
  console.log(JSON.stringify({ ...summary, thresholds: fixtures.thresholds, missed }, null, 2));
} else {
  const f = (x: number) => x.toFixed(3);
  console.log(
    `Fact-check eval · offline verifier · ${fixtures.sources.length} sources · ${report.cases} claims`,
  );
  console.log(
    `accuracy ${f(report.accuracy)} · macro-F1 ${f(report.macro_f1)} · citations ${f(report.citation_accuracy)} · ECE ${f(report.ece)}`,
  );
  for (const [c, m] of Object.entries(report.per_class))
    console.log(
      `  ${c.padEnd(13)} precision ${f(m.precision)} recall ${f(m.recall)} F1 ${f(m.f1)} (${m.support})`,
    );
  for (const [t, m] of Object.entries(report.by_type))
    console.log(`  ${t.padEnd(13)} accuracy ${f(m.accuracy)} (${m.cases})`);
  if (flag('--show-misses'))
    for (const r of report.results.filter((x) => !x.correct || x.cited === false))
      console.log(
        `  miss: ${JSON.stringify(r.claim)} want ${r.expected}, got ${r.verdict}${r.cited === false ? ', wrong citation' : ''}`,
      );
  console.log(missed.length ? `Gate FAILED: ${missed.join('; ')}` : 'Gate passed');
}
process.exit(missed.length ? 1 : 0);
