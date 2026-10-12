/**
 * Settings → Usage: Claude Code's plan limits read like its own /usage,
 * an API key sign-in is told plainly, Ancile's totals come with a chart
 * and a breakdown, and every context meter is the same meter.
 */
import type { ClaudeCodePlanLimits, UsageReport } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    children,
    to: _to,
    params: _p,
    ...rest
  }: {
    children: ReactNode;
    to: string;
    params?: unknown;
  }) => (
    <a href="#link" {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { resetWords, toneOf, windowLine } from '../src/usage/api';
import { ContextGauge, contextTone, contextWords } from '../src/usage/Meter';
import { NOT_A_PLAN, PlanLimits } from '../src/usage/PlanLimits';
import { AncileUsage, UsageGroup } from '../src/usage/UsageView';

const mocked = api as unknown as Record<'get' | 'post' | 'put' | 'patch' | 'del', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

const NOW = Date.parse('2026-10-12T13:30:00Z');
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const PLAN: ClaudeCodePlanLimits = {
  available: true,
  plan: 'max',
  windows: [
    {
      id: 'five_hour',
      kind: 'session',
      label: null,
      percent: 42,
      resets_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
      status: null,
      updated_at: ago(120_000),
    },
    {
      id: 'seven_day',
      kind: 'week',
      label: null,
      percent: 93,
      resets_at: new Date(Date.now() + 4 * 86_400_000).toISOString(),
      status: 'allowed_warning',
      updated_at: ago(120_000),
    },
    {
      id: 'model:opus',
      kind: 'week_model',
      label: 'Opus',
      percent: 75,
      resets_at: null,
      status: null,
      updated_at: ago(120_000),
    },
  ],
  updated_at: ago(120_000),
  source: 'usage',
  can_refresh: true,
};

const REPORT: UsageReport = {
  range: 'week',
  tz: 'Europe/London',
  from: '2026-10-05T23:00:00.000Z',
  to: '2026-10-12T23:00:00.000Z',
  bucket: 'day',
  totals: { input_tokens: 12_000, output_tokens: 3_000, cached_tokens: 500, cost_usd: 0.31, answers: 9 },
  series: ['06', '07', '08', '09', '10', '11', '12'].map((d, i) => ({
    start: `2026-10-${d}`,
    tokens: i === 6 ? 10_000 : i === 3 ? 5_000 : 0,
    cost_usd: 0,
    by_engine: (i === 6 ? { gateway: 4_000, claude_code: 6_000 } : i === 3 ? { lab: 5_000 } : {}) as Record<
      string,
      number
    >,
  })),
  by_engine: [
    {
      engine: 'gateway',
      input_tokens: 3_000,
      output_tokens: 1_000,
      cached_tokens: 0,
      cost_usd: 0.01,
      answers: 4,
    },
    {
      engine: 'claude_code',
      input_tokens: 5_000,
      output_tokens: 1_000,
      cached_tokens: 500,
      cost_usd: 0.3,
      answers: 3,
    },
    { engine: 'lab', input_tokens: 4_000, output_tokens: 1_000, cached_tokens: 0, cost_usd: 0, answers: 2 },
  ],
  by_model: [
    {
      model_id: 'claude-code/claude-opus-5-5',
      engine: 'claude_code',
      input_tokens: 5_000,
      output_tokens: 1_000,
      cached_tokens: 500,
      cost_usd: 0.3,
      answers: 3,
    },
    {
      model_id: 'openai/gpt-5',
      engine: 'gateway',
      input_tokens: 3_000,
      output_tokens: 1_000,
      cached_tokens: 0,
      cost_usd: 0.01,
      answers: 4,
    },
  ],
  by_provider: [],
  estimated_cost_usd: 0.3,
};

beforeEach(() => {
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
});
afterEach(cleanup);

describe('plan limits', () => {
  it('reads like Claude Code: each window, how much is used, when it resets, and how fresh', async () => {
    mocked.get.mockResolvedValue(PLAN);
    const { container } = wrap(<PlanLimits />);
    expect(await screen.findByText('Current session (5 hours)')).toBeInTheDocument();
    expect(screen.getByText('42% used')).toBeInTheDocument();
    expect(screen.getByText('This week')).toBeInTheDocument();
    expect(screen.getByText('This week, Opus')).toBeInTheDocument();
    expect(screen.getByText(/^Resets at \d{1,2}:\d{2} [ap]m$/)).toBeInTheDocument();
    expect(screen.getByText(/^Updated 2 min ago · Max plan$/)).toBeInTheDocument();
    const tones = [...container.querySelectorAll('.u-meter')].map((m) => m.getAttribute('data-tone'));
    expect(tones).toEqual(['calm', 'over', 'high']);
    expect(mocked.get).toHaveBeenCalledWith('/claude-code/plan-limits');
    mocked.get.mockResolvedValue({ ...PLAN, updated_at: new Date().toISOString() });
    fireEvent.click(screen.getByRole('button', { name: "Refresh Claude Code's plan limits" }));
    await waitFor(() => expect(mocked.get).toHaveBeenCalledWith('/claude-code/plan-limits?refresh=1'));
    expect(await screen.findByText(/^Updated just now/)).toBeInTheDocument();
  });

  it('tells an API key sign-in that plan limits do not apply', async () => {
    mocked.get.mockResolvedValue({ ...PLAN, available: false, plan: null, windows: [] });
    wrap(<PlanLimits />);
    expect(await screen.findByText(NOT_A_PLAN)).toBeInTheDocument();
    expect(document.querySelector('.u-meter')).toBeNull();
  });

  it('says how to get them when Claude Code is not set up', async () => {
    mocked.get.mockResolvedValue({
      ...PLAN,
      available: null,
      windows: [],
      updated_at: null,
      can_refresh: false,
    });
    wrap(<PlanLimits />);
    expect(await screen.findByText(/Install and sign in to Claude Code/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull();
  });

  it('words a window the way the CLI does', () => {
    const at = new Date(NOW + 3 * 86_400_000);
    expect(resetWords(at.toISOString(), NOW)).toMatch(/^resets [A-Z][a-z]{2} \d{1,2}:\d{2} [ap]m$/);
    expect(resetWords(new Date(NOW - 1000).toISOString(), NOW)).toBe('reset since');
    const first = PLAN.windows[0];
    if (!first) throw new Error('fixture');
    expect(windowLine({ ...first, resets_at: null })).toBe('Current session (5 hours): 42% used');
    expect([toneOf(10), toneOf(70), toneOf(90), toneOf(null)]).toEqual(['calm', 'high', 'over', 'calm']);
  });
});

describe('NVX Ancile usage', () => {
  it('totals, a stacked bar per day, and the breakdowns, with the estimate told apart', () => {
    const { container } = wrap(<AncileUsage report={REPORT} />);
    expect(screen.getByText('15k')).toBeInTheDocument();
    expect(screen.getByText('$0.31')).toBeInTheDocument();
    expect(
      screen.getByText("$0.30 of it is Claude Code's estimate at API list prices, not your bill"),
    ).toBeInTheDocument();
    const bars = container.querySelectorAll('.u-chart__bar');
    expect([...bars].map((b) => b.getAttribute('data-engine'))).toEqual(['lab', 'gateway', 'claude_code']);
    expect(screen.getByText('Mon 12')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'By engine' })).toHaveTextContent(
      /Chat and flows.*Claude Code.*Lab/,
    );
    expect(screen.getByRole('region', { name: 'By model' })).toHaveTextContent(/claude-opus-5-5.*gpt-5/);
  });

  it('the page asks for today first, in this browser’s time zone, and switches range', async () => {
    mocked.get.mockImplementation(async (path: string) => {
      if (path.startsWith('/usage')) return { ...REPORT, range: path.includes('week') ? 'week' : 'day' };
      if (path === '/claude-code/plan-limits') return PLAN;
      if (path === '/compute/status') return { configured: false, reachable: false };
      return null;
    });
    wrap(<UsageGroup />);
    expect(await screen.findByText('NVX Ancile usage')).toBeInTheDocument();
    await waitFor(() =>
      expect(mocked.get.mock.calls.map((c) => c[0])).toContainEqual(
        expect.stringMatching(/^\/usage\?range=day&tz=/),
      ),
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Last 7 days' }));
    await waitFor(() =>
      expect(mocked.get.mock.calls.map((c) => c[0])).toContainEqual(
        expect.stringMatching(/^\/usage\?range=week/),
      ),
    );
    expect(await screen.findByText('Current session (5 hours)')).toBeInTheDocument();
  });
});

describe('the context meter', () => {
  it('is one meter for every thread: the share, the tick where it compacts, and words that say both', () => {
    const { container } = wrap(<ContextGauge percent={62} compactsAt={95} />);
    const meter = screen.getByRole('meter', { name: '62% of context: compacts at 95%' });
    expect(meter).toHaveAttribute('aria-valuenow', '62');
    expect(container.querySelector('.u-meter__mark')).toHaveStyle({ left: '95%' });
    expect(screen.getByText('62%')).toBeInTheDocument();
    expect(contextWords(40, null)).toBe('40% of context');
    expect([contextTone(50, 95), contextTone(85, 95), contextTone(95, 95)]).toEqual(['calm', 'high', 'over']);
    // Claude Code's own line (it compacts earlier) steps sooner.
    expect([contextTone(70, 80), contextTone(80, 80)]).toEqual(['high', 'over']);
  });
});
