/**
 * The pure parts of a fact-check: holding a model's offsets to the answer,
 * reading JSON out of chatter, counting, the seal and the summary in words.
 */
import { describe, expect, it } from 'vitest';
import { countVerdicts, isSealed, summarise, toView } from '../../src/factcheck/pipeline';
import { parseJsonObject, validateClaims } from '../../src/factcheck/steps';
import type { FactcheckRecord } from '../../src/factcheck/store';

const ANSWER = 'Owls are nocturnal. They eat mice and voles. The pump runs at 3000 rpm.';

describe('validateClaims', () => {
  it('keeps offsets that hold and re-finds those that do not', () => {
    const claims = validateClaims(ANSWER, [
      { text: 'Owls are nocturnal.', char_start: 0, char_end: 19, importance: 1 },
      { text: 'The pump runs at 3000 rpm.', char_start: 2, char_end: 9, importance: 0.5 },
    ]);
    expect(claims.map((c) => ANSWER.slice(c.charStart, c.charEnd))).toEqual([
      'Owls are nocturnal.',
      'The pump runs at 3000 rpm.',
    ]);
  });

  it('accepts a reworded claim over its span, and drops one it cannot place', () => {
    const claims = validateClaims(ANSWER, [
      { text: 'Owls eat mice and voles.', char_start: 20, char_end: 44, importance: 1 },
      { text: 'Bats sleep in caves.', char_start: 0, char_end: 5 },
    ]);
    expect(claims).toHaveLength(1);
    expect(ANSWER.slice(claims[0]?.charStart, claims[0]?.charEnd)).toBe('They eat mice and voles.');
  });

  it('drops the less important of two overlapping claims and orders by position', () => {
    const claims = validateClaims(ANSWER, [
      { text: 'The pump runs at 3000 rpm.', importance: 1 },
      { text: 'runs at 3000 rpm', importance: 0.2 },
      { text: 'Owls are nocturnal.', importance: 0.5 },
    ]);
    expect(claims.map((c) => c.text)).toEqual(['Owls are nocturnal.', 'The pump runs at 3000 rpm.']);
  });

  it('lands on the exact words when the model counted code points past an emoji', () => {
    const answer = 'Pumps 🚰 matter. The pump runs at 3000 rpm.';
    const exact = answer.indexOf('The pump');
    // A model counting code points is one unit short after the emoji.
    const [c] = validateClaims(answer, [
      { text: 'The pump runs at 3000 rpm.', char_start: exact - 1, char_end: exact - 1 + 26, importance: 1 },
    ]);
    expect(answer.slice(c?.charStart, c?.charEnd)).toBe('The pump runs at 3000 rpm.');
  });

  it('picks the occurrence nearest the offsets the model gave', () => {
    const answer = 'It is safe. Later on: it is safe.';
    const second = answer.lastIndexOf('it is safe');
    const [c] = validateClaims(answer, [
      { text: 'it is safe', char_start: second + 1, char_end: second + 30 },
    ]);
    expect(c?.charStart).toBe(second);
  });

  it('never splits a surrogate pair', () => {
    const answer = 'Rotor wear 🔩 shows after a season.';
    const emoji = answer.indexOf('🔩');
    // The span ends between the two halves of the emoji.
    const [c] = validateClaims(answer, [{ text: 'rotor wears', char_start: 0, char_end: emoji + 1 }]);
    expect(c).toBeDefined();
    const span = answer.slice(c?.charStart, c?.charEnd);
    expect(/[\uD800-\uDBFF]$/.test(span) || /^[\uDC00-\uDFFF]/.test(span)).toBe(false);
  });

  it('defaults to checkable and clamps importance', () => {
    const [c] = validateClaims(ANSWER, [{ text: 'Owls are nocturnal.', importance: 4 }]);
    expect(c).toMatchObject({ checkable: true, importance: 1 });
  });
});

describe('parseJsonObject', () => {
  it('reads the object out of fences and chatter', () => {
    expect(parseJsonObject('Sure!\n```json\n{"claims": []}\n```')).toEqual({ claims: [] });
    expect(parseJsonObject('no json here')).toBeUndefined();
    expect(parseJsonObject('{broken')).toBeUndefined();
  });
});

describe('the result in words', () => {
  const rec = (verdicts: FactcheckRecord['claims'][number]['verdict'][]): FactcheckRecord => ({
    id: 'fck_1',
    message_id: 'msg_1',
    run_id: 'run_1',
    status: 'done',
    confidence: 0.8,
    verifier_model_id: 'offline/echo',
    scope: { notebook_id: null, web: false },
    error: null,
    created_at: '2026-10-07T00:00:00.000Z',
    finished_at: '2026-10-07T00:00:01.000Z',
    claims: verdicts.map((verdict, i) => ({
      id: `clm_${i}`,
      text: 'x',
      char_start: i,
      char_end: i + 1,
      importance: 1,
      verdict,
      confidence: 0.8,
      support: 0.7,
      agreement: 1,
      retrieval: 0.9,
      evidence: [],
      rationale: '',
    })),
  });

  it('seals only when every checkable claim is verified', () => {
    expect(isSealed(countVerdicts(rec(['verified', 'not_checkable']).claims))).toBe(true);
    expect(isSealed(countVerdicts(rec(['verified', 'unverified']).claims))).toBe(false);
    expect(isSealed(countVerdicts(rec(['not_checkable']).claims))).toBe(false);
    expect(toView(rec(['verified'])).sealed).toBe(true);
    expect(toView({ ...rec(['verified']), status: 'running' }).sealed).toBe(false);
  });

  it('says what it found', () => {
    expect(toView(rec(['verified', 'contradicted', 'unverified'])).summary).toBe(
      '1 of 3 claims verified, 1 contradicted by your sources and 1 without enough evidence. Confidence 80%, weighted by how much the answer relies on each claim.',
    );
    expect(summarise({ status: 'done', confidence: null, counts: countVerdicts([]) })).toBe(
      'This answer makes no claims that can be checked.',
    );
    expect(toView(rec(['verified'])).claims[0]?.explanation).toMatch(/Overall confidence 80%/);
  });
});
