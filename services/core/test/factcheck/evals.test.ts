/**
 * The fact-check eval (tests/eval/factcheck): the labelled set runs through
 * the real verifier step and score on the offline models and meets the
 * checked-in floors; the metrics and the BM25 stand-in behave.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CaseResult,
  expectedCalibrationError,
  gatherFromIndex,
  indexSources,
  loadEvalFixtures,
  missedThresholds,
  offlineEvalDeps,
  runFactcheckEval,
  summarise,
  topPassages,
} from '../../src/factcheck/evals';

const ROOT = join(import.meta.dirname, '../../../..');

describe('the fact-check eval', () => {
  it('meets the checked-in floors on the offline models', async () => {
    const fixtures = await loadEvalFixtures(join(ROOT, 'tests/eval/factcheck'));
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(40);
    const report = await runFactcheckEval(await offlineEvalDeps(join(ROOT, 'prompts')), fixtures);
    expect(missedThresholds(report, fixtures.thresholds)).toEqual([]);
    // Deterministic: a second run gives the same numbers.
    const again = await runFactcheckEval(await offlineEvalDeps(join(ROOT, 'prompts')), fixtures);
    expect(again.accuracy).toBe(report.accuracy);
    expect(again.ece).toBe(report.ece);
  }, 30_000);

  it('BM25 finds the passage that names the claim, with the quote at its offsets', () => {
    const index = indexSources([
      {
        id: 'a',
        title: 'A',
        passages: ['Owls hunt at night. They eat voles.', 'The pump runs at 3000 rpm.'],
      },
      { id: 'b', title: 'B', passages: ['Pumps need priming before use.'] },
    ]);
    expect(topPassages(index, 'the pump runs at 3000 rpm', 1)[0]?.passage.ref).toBe('a#1');
    expect(topPassages(index, 'unrelated words entirely')).toEqual([]);
    const g = gatherFromIndex(index, 'Owls eat voles');
    const e = g.evidence[0];
    expect(e?.quote).toBe('They eat voles.');
    const joined = 'Owls hunt at night. They eat voles.\n\nThe pump runs at 3000 rpm.';
    expect(joined.slice(e?.char_start ?? 0, e?.char_end ?? 0)).toBe('They eat voles.');
    expect(g.coverage).toBe(1);
  });

  it('macro-F1, citations and calibration are computed as stated', () => {
    const r = (expected: CaseResult['expected'], verdict: CaseResult['verdict'], p: number): CaseResult => ({
      claim: 'c',
      type: 't',
      label:
        expected === 'verified' ? 'supported' : expected === 'contradicted' ? 'contradicted' : 'insufficient',
      expected,
      verdict,
      confidence: p,
      correct: expected === verdict,
      cited: expected === verdict && expected !== 'unverified' ? true : null,
    });
    const s = summarise([
      r('verified', 'verified', 0.9),
      r('contradicted', 'unverified', 0.3),
      r('unverified', 'unverified', 0.4),
    ]);
    expect(s.accuracy).toBeCloseTo(2 / 3);
    expect(s.per_class.unverified).toMatchObject({ precision: 0.5, recall: 1 });
    expect(s.per_class.contradicted?.f1).toBe(0);
    expect(s.macro_f1).toBeCloseTo((1 + 0 + 2 / 3) / 3);
    expect(s.citation_accuracy).toBe(1);
    expect(
      expectedCalibrationError([
        { p: 1, y: 1 },
        { p: 0, y: 0 },
      ]),
    ).toBe(0);
    expect(expectedCalibrationError([{ p: 0.9, y: 0 }])).toBeCloseTo(0.9);
    expect(missedThresholds(s, { accuracy: 0.9, macro_f1: 0.1, citation_accuracy: 1, max_ece: 1 })).toEqual([
      'accuracy 0.667 is under 0.900',
    ]);
  });
});
