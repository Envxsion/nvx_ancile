import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaimCheckInfo, Factcheck } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { isSealed, summarise } from '../../src/factcheck/pipeline';
import { explainScore, messageConfidence, scoreClaim } from '../../src/factcheck/score';
import { RawVerdict, VERDICT_JSON_SCHEMA, worst } from '../../src/factcheck/steps';
import { coerceStance, tolerantVerdict } from '../../src/factcheck/tolerant';
import { fakeVerdict } from '../../src/gateway/fake-structured';

const prompts = join(__dirname, '../../../../prompts/factcheck');
const EVEREST = [{ ref: 'E1', text: 'Mount Everest is 8,848.86 metres tall.' }];

describe('graded verdicts (partly holds)', () => {
  it('the offline checker calls a rounded figure partly, not contradicted', () => {
    const v = fakeVerdict('Mount Everest is 8,849 metres tall.', EVEREST);
    expect(v.stance).toBe('partly');
    expect(v.nuance).toMatch(/rounds it/);
    expect(v.evidence[0]?.stance).toBe('supports');
    // A different figure beyond rounding is still wrong, and a year off by one is not "rounded".
    expect(fakeVerdict('Mount Everest is 8,000 metres tall.', EVEREST).stance).toBe('contradicted');
    expect(
      fakeVerdict('The bridge opened in 1933.', [{ ref: 'E1', text: 'The bridge opened in 1932.' }]).stance,
    ).toBe('contradicted');
  });

  it('scores a partly checker as a partly claim, and a contradicting checker still wins', () => {
    const evidence = [{ stance: 'supports' as const, score: 0.8 }];
    const base = { checkable: true, evidence, coverage: 1, checkerConfidence: 0.9 };
    expect(scoreClaim({ ...base, verifier: 'partly' }).verdict).toBe('partly');
    expect(scoreClaim({ ...base, verifier: ['supported', 'partly'] }).verdict).toBe('partly');
    expect(scoreClaim({ ...base, verifier: ['supported', 'supported'] }).verdict).toBe('verified');
    expect(scoreClaim({ ...base, verifier: ['partly', 'insufficient'] }).verdict).toBe('unverified');
    expect(scoreClaim({ ...base, verifier: ['partly', 'contradicted'] }).verdict).toBe('contradicted');
    // Unsure of itself: not partly either.
    expect(scoreClaim({ ...base, verifier: 'partly', checkerConfidence: 0.3 }).verdict).toBe('unverified');
    expect(explainScore(scoreClaim({ ...base, verifier: 'partly' }))).toMatch(/half a pass/);
  });

  it('merges several checkers: supports + partly reads partly', () => {
    expect(worst(['supported', 'partly'])).toBe('partly');
    expect(worst(['partly', 'partly'])).toBe('partly');
    expect(worst(['supported', 'supported'])).toBe('supported');
    expect(worst(['partly', 'insufficient'])).toBe('insufficient');
    expect(worst(['supported', 'partly', 'contradicted'])).toBe('contradicted');
  });

  it('counts a partly claim as half a pass in the answer score, and it never seals', () => {
    const claim = (verdict: 'verified' | 'partly') => ({
      importance: 1,
      score: { verdict, confidence: 0.8, support: 0.8, agreement: 1, retrieval: 0.8 },
    });
    expect(messageConfidence([claim('verified'), claim('verified')])).toBeCloseTo(0.8);
    expect(messageConfidence([claim('verified'), claim('partly')])).toBeCloseTo(0.6);
    const counts = { verified: 2, partly: 1, unverified: 0, contradicted: 0, not_checkable: 0 };
    expect(isSealed(counts)).toBe(false);
    expect(isSealed({ ...counts, partly: 0 })).toBe(true);
    expect(summarise({ status: 'done', confidence: 0.7, counts })).toMatch(
      /^2 of 3 claims verified and 1 holds in part\./,
    );
  });

  it('reads the ways a model says partly, and keeps the nuance', () => {
    expect(coerceStance('Partially correct')).toBe('partly');
    expect(coerceStance('mostly true')).toBe('partly');
    expect(coerceStance('unclear')).toBe('insufficient');
    const raw = tolerantVerdict({ verdict: 'partly', rationale: 'r', caveat: 'It rounds the figure.' });
    const parsed = RawVerdict.parse(raw);
    expect(parsed.stance).toBe('partly');
    expect(parsed.nuance).toBe('It rounds the figure.');
    expect(RawVerdict.parse({ stance: 'supported' }).nuance).toBe('');
  });

  it('asks for the new field and word in the schema and in both prompts', () => {
    expect(VERDICT_JSON_SCHEMA.properties.stance.enum).toContain('partly');
    expect(VERDICT_JSON_SCHEMA.required).toContain('nuance');
    for (const f of ['verify-claim.md', 'verify-general.md']) {
      const text = readFileSync(join(prompts, f), 'utf8');
      expect(text).toContain('"partly"');
      expect(text).toContain('"nuance"');
    }
    const verify = readFileSync(join(prompts, 'verify-claim.md'), 'utf8');
    expect(verify).toMatch(/never "contradicted"/);
  });

  it('still reads records from before graded verdicts', () => {
    expect(ClaimCheckInfo.parse({ tier_used: 'fast', model_id: 'm' }).nuance).toBeUndefined();
    const old = Factcheck.shape.counts.parse({
      verified: 1,
      unverified: 0,
      contradicted: 0,
      not_checkable: 0,
    });
    expect(old.partly).toBe(0);
  });
});
