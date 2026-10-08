import { describe, expect, it } from 'vitest';
import {
  agreementScore,
  explainScore,
  messageConfidence,
  retrievalScore,
  scoreClaim,
  squash,
  supportScore,
} from '../../src/factcheck/score';

describe('confidence components', () => {
  it('squashes evidence into [0,1] and ignores net-negative support', () => {
    expect(squash(0)).toBe(0);
    expect(squash(-2)).toBe(0);
    expect(squash(1)).toBeCloseTo(0.632, 3);
    expect(squash(100)).toBeLessThanOrEqual(1);
  });

  it('nets supporting against contradicting evidence', () => {
    expect(
      supportScore([
        { stance: 'supports', score: 0.9 },
        { stance: 'contradicts', score: 0.9 },
      ]),
    ).toBe(0);
    expect(supportScore([{ stance: 'neutral', score: 1 }])).toBe(0);
  });

  it('averages several verifiers', () => {
    expect(agreementScore(['supported', 'insufficient'])).toBe(0.75);
    expect(agreementScore([])).toBe(0.5);
  });

  it('weights retrieval by coverage over the top three', () => {
    expect(
      retrievalScore(
        [
          { stance: 'supports', score: 1 },
          { stance: 'neutral', score: 0.5 },
          { stance: 'neutral', score: 0 },
          { stance: 'neutral', score: 0.9 },
        ],
        0.5,
      ),
    ).toBeCloseTo(0.4, 5);
    expect(retrievalScore([], 1)).toBe(0);
  });
});

describe('scoreClaim', () => {
  it('verifies a well-supported claim the verifier agrees with', () => {
    const s = scoreClaim({
      checkable: true,
      evidence: [
        { stance: 'supports', score: 0.95 },
        { stance: 'supports', score: 0.8 },
      ],
      verifier: 'supported',
      coverage: 1,
    });
    expect(s.verdict).toBe('verified');
    expect(s.confidence).toBeGreaterThan(0.75);
  });

  it('marks a claim with no evidence as unverified with low confidence', () => {
    const s = scoreClaim({ checkable: true, evidence: [], verifier: 'insufficient', coverage: 0 });
    expect(s).toMatchObject({ verdict: 'unverified', support: 0, retrieval: 0, agreement: 0.5 });
    expect(s.confidence).toBeCloseTo(0.15, 5);
  });

  it('contradicts when sources push back, even if the verifier was fooled', () => {
    const s = scoreClaim({
      checkable: true,
      evidence: [{ stance: 'contradicts', score: 0.9 }],
      verifier: 'supported',
      coverage: 1,
    });
    expect(s.verdict).toBe('contradicted');
  });

  it('contradicts when the verifier disagrees', () => {
    expect(
      scoreClaim({
        checkable: true,
        evidence: [{ stance: 'supports', score: 0.9 }],
        verifier: 'contradicted',
        coverage: 1,
      }).verdict,
    ).toBe('contradicted');
  });

  it('does not score opinions', () => {
    expect(scoreClaim({ checkable: false, evidence: [], verifier: 'supported', coverage: 1 })).toMatchObject({
      verdict: 'not_checkable',
      confidence: 0,
    });
  });

  it('explains itself in words', () => {
    const s = scoreClaim({
      checkable: true,
      evidence: [
        { stance: 'supports', score: 0.95 },
        { stance: 'supports', score: 0.9 },
      ],
      verifier: 'supported',
      coverage: 1,
    });
    expect(explainScore(s)).toMatch(/^Your sources support it well \(\d+%\), a second model agrees/);
  });
});

describe('messageConfidence', () => {
  it('is the importance-weighted mean over checkable claims', () => {
    const v = (c: number) => ({
      verdict: 'verified' as const,
      confidence: c,
      support: 0,
      agreement: 0,
      retrieval: 0,
    });
    const op = { verdict: 'not_checkable' as const, confidence: 0, support: 0, agreement: 0, retrieval: 0 };
    expect(
      messageConfidence([
        { importance: 3, score: v(1) },
        { importance: 1, score: v(0) },
        { importance: 5, score: op },
      ]),
    ).toBe(0.75);
    expect(messageConfidence([{ importance: 1, score: op }])).toBeNull();
  });
});

describe('edge cases', () => {
  it('scores a claim every source contradicts at zero support, whatever the verifier says', () => {
    const s = scoreClaim({
      checkable: true,
      evidence: [
        { stance: 'contradicts', score: 0.9 },
        { stance: 'contradicts', score: 0.7 },
      ],
      verifier: 'insufficient',
      coverage: 1,
    });
    expect(s.verdict).toBe('contradicted');
    expect(s.support).toBe(0);
    expect(s.confidence).toBeLessThan(0.4);
  });

  it('keeps out-of-range scores in [0, 1]', () => {
    const s = scoreClaim({
      checkable: true,
      evidence: [{ stance: 'supports', score: 7 }],
      verifier: 'supported',
      coverage: 3,
    });
    expect(s.confidence).toBeLessThanOrEqual(1);
    expect(s.retrieval).toBe(1);
  });

  it('has no message score when nothing could be checked', () => {
    expect(messageConfidence([])).toBeNull();
  });

  it('honours configured weights that do not sum to one', () => {
    const s = scoreClaim(
      { checkable: true, evidence: [], verifier: 'supported', coverage: 0 },
      { support: 0, agreement: 2, retrieval: 0 },
    );
    expect(s.confidence).toBe(1);
  });
});
