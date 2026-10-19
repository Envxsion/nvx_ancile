/**
 * Check my reviewers (R2), the Cockpit half: the cost is on screen before
 * anything runs, the estimate call posts nothing, only the click posts
 * { confirm: true }, and the result is a table by category.
 */
import type { ReviewerCheckEstimate, ReviewerCheckResult } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { CheckReviewers, costWords } from '../src/auto/CheckReviewers';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';

const mocked = api as unknown as Record<'get' | 'post', ReturnType<typeof vi.fn>>;

const est = (p: Partial<ReviewerCheckEstimate> = {}): ReviewerCheckEstimate => ({
  injection_cases: 45,
  normal_cases: 33,
  reviewer_calls: 40,
  first_reviewer: 'jev_openrouter',
  reviewers: [
    { id: 'jev_openrouter', label: 'Jev through OpenRouter', available: true, local: false },
    { id: 'rules', label: 'Built-in rules', available: true, local: true },
  ],
  est_usd_max: 0.004,
  est_input_tokens: 36000,
  price_basis: 'assumed',
  costs_money: true,
  sends_cases_out: true,
  ...p,
});

const result: ReviewerCheckResult = {
  ran_at: '2026-10-19T00:00:00.000Z',
  categories: [
    {
      category: 'Shell commands',
      injection_cases: 20,
      caught: 20,
      missed: 0,
      normal_cases: 18,
      false_alarms: 1,
    },
    { category: 'File changes', injection_cases: 10, caught: 9, missed: 1, normal_cases: 8, false_alarms: 0 },
  ],
  injection_cases: 30,
  caught: 29,
  caught_by_rules: 25,
  missed: 1,
  normal_cases: 26,
  false_alarms: 1,
  false_alarms_per_10: 0.4,
  reviewer_calls: 40,
  answered_by: ['jev_openrouter'],
  cost_usd: 0.0031,
  stopped_at_ceiling: false,
  missed_names: ['write outside the workspace'],
  false_alarm_names: ['read docs'],
};

beforeEach(() => {
  queryClient.clear();
  mocked.get.mockReset();
  mocked.post.mockReset();
});

describe('Check my reviewers', () => {
  it('shows the most it can cost before anything runs, and posts nothing', async () => {
    mocked.get.mockResolvedValue(est());
    render(
      <QueryClientProvider client={queryClient}>
        <CheckReviewers />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('button', { name: /Run the check \(up to \$0\.0040\)/ })).toBeTruthy();
    expect(screen.getByText(/no more than \$0\.0040/)).toBeTruthy();
    expect(mocked.post).not.toHaveBeenCalled();
  });

  it('posts confirm only on the click, then shows caught, missed and false alarms by category', async () => {
    mocked.get.mockResolvedValue(est());
    mocked.post.mockResolvedValue(result);
    render(
      <QueryClientProvider client={queryClient}>
        <CheckReviewers />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Run the check \(up to/ }));
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());
    expect(mocked.post).toHaveBeenCalledTimes(1);
    expect(mocked.post).toHaveBeenCalledWith('/auto/reviewer-check', { confirm: true });
    expect(screen.getByText('Shell commands')).toBeTruthy();
    expect(screen.getByText('20 of 20')).toBeTruthy();
    expect(screen.getByText(/Missed: write outside the workspace/)).toBeTruthy();
  });

  it('says what the ceiling rests on', () => {
    expect(costWords(est())).toMatch(/36,000 tokens/);
    expect(costWords(est())).toMatch(/cautious rate/);
    expect(costWords(est({ price_basis: 'listed' }))).toMatch(/listed price/);
  });

  it('says a local check costs nothing', () => {
    expect(costWords(est({ costs_money: false, est_usd_max: 0, first_reviewer: 'local_model' }))).toMatch(
      /costs nothing/,
    );
  });
});
