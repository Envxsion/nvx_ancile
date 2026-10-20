/**
 * ------------------------------------------------------------------
 *  Title    |  The plan's monthly API credit (CR1)
 *  Ref      |  docs/models.md (Monthly API credit)
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  Models paid from the credit wear the "Monthly credit"
 *           |  tag beside "Plan"; Settings marks the Anthropic key and
 *           |  shows the meter; the receipt says where the money came
 *           |  from. No call reaches Anthropic.
 * ------------------------------------------------------------------
 */

import { type CreditStatus, PLAN_CREDIT_PAYER } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { CreditMeter, creditWords, PlanCreditSetting } from '../src/credentials/PlanCredit';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import type { ModelView } from '../src/lib/types';
import {
  billingBadge,
  billingTitle,
  billingWords,
  displayName,
  modelBadge,
  planTwinOf,
  sameModelBothWays,
} from '../src/models/billing';
import { payKind } from '../src/receipt/figures';

const mocked = api as unknown as Record<'get' | 'put', ReturnType<typeof vi.fn>>;

const credit = { kind: 'credit', payer: PLAN_CREDIT_PAYER } as const;
const model = (
  id: string,
  name: string,
  billing: ModelView['billing'],
  p: Partial<ModelView> = {},
): ModelView => ({
  id,
  name,
  provider: 'Anthropic',
  hue: 'coral',
  via: 'direct',
  contextWindow: 200_000,
  status: 'ready',
  chat: true,
  billing,
  price: { in: 0, out: 0 },
  ...p,
});

const STATUS: CreditStatus = {
  enabled: true,
  monthly_usd: 100,
  spent_usd: 37.5,
  left_usd: 62.5,
  used: 0.375,
  cycle_start: '2026-10-01T00:00:00.000Z',
  cycle_ends: '2026-11-01T00:00:00.000Z',
  days_left: 12,
  exhausted: false,
  counted_by_ancile: true,
  tz: 'UTC',
};

beforeEach(() => {
  mocked.get.mockReset();
  mocked.put.mockReset();
  queryClient.clear();
});
afterEach(cleanup);

describe('who pays: the monthly credit', () => {
  it('has its own words and a tag distinct from the plan', () => {
    expect(billingWords(credit)).toBe("Your plan's monthly API credit");
    expect(billingBadge(credit)).toBe('Monthly credit');
    expect(billingBadge({ kind: 'plan', payer: 'max' })).toBe('Plan');
    expect(modelBadge({ billing: credit, via: 'direct' })).toBe('Monthly credit');
    expect(billingTitle(credit)).toBe("Your plan's monthly API credit, spent before anything is charged");
    expect(billingTitle(credit, { in: 5, out: 25 })).toContain('$5 in, $25 out per million tokens');
  });

  it('is priced like a key on a receipt', () => {
    expect(payKind(credit)).toBe('key');
    expect(payKind({ kind: 'plan', payer: 'max' })).toBe('plan');
  });

  it('names the same Claude model on the plan and on the credit, in the picker', () => {
    const plan = model('claude-code/opus', 'Claude Code: Opus', { kind: 'plan', payer: 'max' });
    const api5 = model('anthropic/claude-opus-5-5', 'Claude Opus 5.5', credit);
    const cc = model('claude-code/opus@credit', 'Claude Code: Opus (monthly credit)', credit);
    const dupes = sameModelBothWays([plan, api5, cc]);
    expect(dupes.has('claude-code/opus')).toBe(true);
    expect(dupes.has('anthropic/claude-opus-5-5')).toBe(true);
    expect(displayName(plan, dupes)).toBe('Claude Code: Opus · Max plan');
    expect(displayName(api5, dupes)).toBe('Claude Opus 5.5 · Monthly credit');
    // The Claude Code variant already says so in its name.
    expect(displayName(cc, dupes)).toBe('Claude Code: Opus (monthly credit)');
    expect(planTwinOf(api5, [plan, api5])?.id).toBe('claude-code/opus');
  });
});

describe('the credit meter', () => {
  it('says what is spent, what is left and when it renews, and that the count is Ancile’s own', () => {
    expect(creditWords(STATUS)).toEqual({
      spent: '$37.50 of $100.00 used',
      left: '$62.50 left',
      renews: 'Renews 1 Nov',
    });
    render(<CreditMeter status={STATUS} />);
    expect(screen.getByRole('meter', { name: /Monthly API credit/ })).toHaveAttribute('aria-valuenow', '38');
    expect(screen.getByText(/Ancile's own count/)).toBeInTheDocument();
    expect(screen.queryByText(/—/)).toBeNull();
  });

  it('says so when Anthropic has said the credit is used up', () => {
    expect(creditWords({ ...STATUS, exhausted: true }).renews).toBe(
      'Anthropic says it is used up. It renews 1 Nov',
    );
  });
});

describe('Settings, Keys, Anthropic', () => {
  const wrap = (saved: Parameters<typeof PlanCreditSetting>[0]['saved']) =>
    render(
      <QueryClientProvider client={queryClient}>
        <PlanCreditSetting saved={saved} />
      </QueryClientProvider>,
    );

  it('explains the credit with a link to the support article, and starts off', () => {
    wrap(null);
    const toggle = screen.getByRole('switch', { name: "Draws from my plan's monthly credit" });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('link', { name: 'How the credit works' })).toHaveAttribute(
      'href',
      'https://support.claude.com/en/articles/17154008',
    );
    expect(screen.queryByLabelText('Monthly credit (US dollars)')).toBeNull();
  });

  it('saves the amount and reset day with the browser’s time zone', async () => {
    mocked.put.mockResolvedValue(STATUS);
    wrap(null);
    fireEvent.click(screen.getByRole('switch', { name: "Draws from my plan's monthly credit" }));
    fireEvent.change(screen.getByLabelText('Monthly credit (US dollars)'), { target: { value: '200' } });
    fireEvent.change(screen.getByLabelText('Resets on day of the month'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save credit settings' }));
    await waitFor(() => expect(mocked.put).toHaveBeenCalled());
    expect(mocked.put).toHaveBeenCalledWith(
      '/credentials/anthropic/plan-credit',
      expect.objectContaining({ enabled: true, monthly_usd: 200, resets_on_day: 15 }),
    );
  });

  it('will not save a day outside 1 to 31', () => {
    wrap(null);
    fireEvent.click(screen.getByRole('switch', { name: "Draws from my plan's monthly credit" }));
    fireEvent.change(screen.getByLabelText('Resets on day of the month'), { target: { value: '40' } });
    expect(screen.getByRole('button', { name: 'Save credit settings' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('a day from 1 to 31');
  });

  it('shows the meter on the key card once it is saved', async () => {
    mocked.get.mockResolvedValue(STATUS);
    wrap({ enabled: true, monthly_usd: 100, resets_on_day: 1 });
    expect(await screen.findByText(/\$37\.50 of \$100\.00 used/)).toBeInTheDocument();
    expect(mocked.get).toHaveBeenCalledWith('/providers/anthropic/credit');
  });
});
