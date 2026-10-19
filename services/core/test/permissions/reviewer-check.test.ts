/**
 * Check my reviewers (R2): the estimate is free and exact about what will be
 * asked, nothing runs without a confirm, the table adds up, and no floor moves.
 */
import { describe, expect, it } from 'vitest';
import { floorFingerprint, ReviewerCheck } from '../../src/permissions/auto/check';
import { FakeReviewer, INJECTION_CASES, NORMAL_CASES } from '../../src/permissions/auto/evals';
import type { ReviewAnswer, Reviewer, ReviewInput } from '../../src/permissions/auto/reviewers';

class Paid implements Reviewer {
  readonly id = 'jev_openrouter' as const;
  readonly local = false;
  calls = 0;
  costProfile() {
    return {
      rates: this.rates,
      maxOutputTokens: 64,
      requestText: (i: ReviewInput) => JSON.stringify(i.call),
      basis: 'listed' as const,
    };
  }
  rates = { input_per_mtok: 3, output_per_mtok: 15 };
  constructor(private readonly cost: number | null = 0.0001) {}
  async available() {
    return true;
  }
  async review(): Promise<ReviewAnswer> {
    this.calls++;
    return { p_fits: 0.95, p_injection: 0.02, cost_usd: this.cost };
  }
}

describe('Check my reviewers', () => {
  it('shows the cost before anything runs, and asks no reviewer a question', async () => {
    const paid = new Paid();
    const est = await new ReviewerCheck({ reviewers: () => [paid] }).estimate();
    expect(paid.calls).toBe(0);
    expect(est.costs_money).toBe(true);
    expect(est.first_reviewer).toBe('jev_openrouter');
    expect(est.injection_cases).toBe(INJECTION_CASES.length);
    expect(est.normal_cases).toBe(NORMAL_CASES.length);
    expect(est.reviewer_calls).toBeGreaterThan(0);
    expect(est.reviewer_calls).toBeLessThan(INJECTION_CASES.length + NORMAL_CASES.length);
    expect(est.est_usd_max).toBeGreaterThan(0);
    expect(est.est_input_tokens).toBeGreaterThan(est.reviewer_calls * 20);
    expect(est.price_basis).toBe('listed');
  });

  it('the ceiling follows the rates: a dearer model has a higher one, and a free one has none', async () => {
    const cheap = new Paid();
    const dear = new Paid();
    dear.rates = { input_per_mtok: 30, output_per_mtok: 150 };
    const a = await new ReviewerCheck({ reviewers: () => [cheap] }).estimate();
    const b = await new ReviewerCheck({ reviewers: () => [dear] }).estimate();
    expect(b.est_usd_max).toBeCloseTo(a.est_usd_max * 10, 5);
    // Worked by hand: tokens in at the input rate, plus 64 out per call at the output rate.
    expect(a.est_usd_max).toBeCloseTo((a.est_input_tokens * 3 + a.reviewer_calls * 64 * 15) / 1_000_000, 5);
    const free = await new ReviewerCheck({ reviewers: () => [new FakeReviewer('careful')] }).estimate();
    expect(free).toMatchObject({ est_usd_max: 0, est_input_tokens: 0, price_basis: 'free' });
  });

  it('a local reviewer is free and sends nothing out', async () => {
    const est = await new ReviewerCheck({ reviewers: () => [new FakeReviewer('careful')] }).estimate();
    expect(est).toMatchObject({ costs_money: false, sends_cases_out: false, est_usd_max: 0 });
  });

  it('runs only on a click: no confirm, no reviewer is asked', async () => {
    const paid = new Paid();
    const check = new ReviewerCheck({ reviewers: () => [paid] });
    await expect(check.run({ confirm: false })).rejects.toMatchObject({ code: 'auto.check_not_confirmed' });
    expect(paid.calls).toBe(0);
  });

  it('gives a table by category that adds up, with the cost spent', async () => {
    const paid = new Paid();
    const est = await new ReviewerCheck({ reviewers: () => [paid] }).estimate();
    const r = await new ReviewerCheck({ reviewers: () => [paid] }).run({ confirm: true });
    expect(paid.calls).toBe(est.reviewer_calls);
    expect(r.injection_cases).toBe(INJECTION_CASES.length);
    expect(r.normal_cases).toBe(NORMAL_CASES.length);
    expect(r.caught + r.missed).toBe(r.injection_cases);
    expect(r.categories.reduce((n, c) => n + c.caught, 0)).toBe(r.caught);
    expect(r.categories.reduce((n, c) => n + c.false_alarms, 0)).toBe(r.false_alarms);
    // The floors alone hold against a reviewer that approves everything.
    expect(r.missed_names).toEqual([]);
    expect(r.caught_by_rules).toBeGreaterThan(0);
    expect(r.answered_by).toEqual(['jev_openrouter']);
    expect(r.cost_usd).toBeCloseTo(est.reviewer_calls * 0.0001, 6);
    expect(r.stopped_at_ceiling).toBe(false);
  });

  it('stops asking a paid reviewer at the ceiling, and a caller cannot raise it', async () => {
    const paid = new Paid(0.001);
    const check = new ReviewerCheck({ reviewers: () => [paid] });
    const est = await check.estimate();
    const r = await check.run({ confirm: true, max_usd: 0.0025 });
    expect(paid.calls).toBeLessThan(est.reviewer_calls);
    expect(r.stopped_at_ceiling).toBe(true);
    const more = new Paid(0.05);
    const r2 = await new ReviewerCheck({ reviewers: () => [more] }).run({ confirm: true, max_usd: 99 });
    expect(r2.cost_usd).toBeLessThan(est.est_usd_max + 0.2);
    expect(more.calls).toBeLessThan(est.reviewer_calls);
  });

  it('leaves every floor exactly as it was', async () => {
    const before = floorFingerprint();
    const check = new ReviewerCheck({ reviewers: () => [new Paid(), new FakeReviewer('gullible')] });
    await check.estimate();
    await check.run({ confirm: true });
    expect(floorFingerprint()).toEqual(before);
    expect(before.some((l) => l.includes('=block:') || l.includes('=ask:'))).toBe(true);
  });
});
