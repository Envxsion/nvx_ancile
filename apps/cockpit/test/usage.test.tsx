/**
 * Settings → Usage: Claude Code's plan limits read like its own /usage,
 * an API key sign-in is told plainly, Ancile's totals come with a chart
 * and a breakdown, and every context meter is the same meter.
 */
import { readFileSync } from 'node:fs';
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
import { Block } from '../src/routes/settings/rows';
import { paceWords, resetWords, toneOf, windowLine } from '../src/usage/api';
import { ContextGauge, contextTone, contextWords } from '../src/usage/Meter';
import { NOT_A_PLAN, PlanLimits } from '../src/usage/PlanLimits';
import { AncileUsage, ClaudeCodeMeasured, UsageGroup } from '../src/usage/UsageView';
import { here, stripComments } from './tokenCss';

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

  it('never shows an empty block: it says what will appear, and points to claude.ai', async () => {
    mocked.get.mockResolvedValue({
      ...PLAN,
      available: null,
      windows: [],
      updated_at: null,
      can_refresh: true,
    });
    wrap(<PlanLimits />);
    expect(await screen.findByText(/has not reported its limits yet/)).toBeInTheDocument();
    expect(screen.getByText(/current session \(5 hours\) and this week/)).toBeInTheDocument();
    expect(screen.getByText(/A weekly limit per model/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open usage on claude.ai' })).toHaveAttribute(
      'href',
      'https://claude.ai/settings/usage',
    );
  });

  it('warns when the pace so far runs out before the reset, and only then', () => {
    const week = {
      id: 'seven_day',
      kind: 'week' as const,
      label: null,
      status: null,
      updated_at: new Date(NOW).toISOString(),
    };
    // Half the week gone, 80% used: out well before the reset.
    const reset = new Date(NOW + 3.5 * 86_400_000).toISOString();
    expect(paceWords({ ...week, percent: 80, resets_at: reset }, NOW)).toMatch(
      /^At this pace you'll run out (today|tonight|[A-Z][a-z]+day) ?(morning|afternoon|evening|night)?$/,
    );
    // Half the week gone, 40% used: fine.
    expect(paceWords({ ...week, percent: 40, resets_at: reset }, NOW)).toBeNull();
    // Too early to tell.
    const fresh = new Date(NOW + 6.9 * 86_400_000).toISOString();
    expect(paceWords({ ...week, percent: 30, resets_at: fresh }, NOW)).toBeNull();
    const session = { ...week, id: 'five_hour', kind: 'session' as const };
    expect(
      paceWords({ ...session, percent: 90, resets_at: new Date(NOW + 2.5 * 3600_000).toISOString() }, NOW),
    ).toMatch(/^At this pace you'll reach it around \d{1,2}:\d{2} [ap]m$/);
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
    // Claude Code's $0.30 is its estimate of what the Claude plan covers: not added to the total.
    expect(container.querySelector('.u-totals')).toHaveTextContent('Estimated cost$0.01');
    expect(
      screen.getByText(
        'Claude Code is included in your Claude plan (about $0.30 at API list prices, not added here)',
      ),
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

describe('Settings → Usage on screen', () => {
  it('no rule that hides a block left empty by search hides a block of Usage', async () => {
    // Settings hid every block without a setting row: Usage has none, so its
    // whole page vanished, leaving the heading and the footer.
    mocked.get.mockImplementation(async (path: string) => {
      if (path.startsWith('/usage')) return REPORT;
      if (path === '/claude-code/plan-limits') return PLAN;
      if (path === '/compute/status') return { configured: false, reachable: false };
      return null;
    });
    const css = stripComments(readFileSync(here('../src/styles/kit.css'), 'utf8'));
    const hiding = [...css.matchAll(/([^{}]*\.setting-block[^{}]*)\{([^}]*)\}/g)]
      .filter(([, , body]) => /display:\s*none/.test(body ?? ''))
      .map(([, sel]) => (sel ?? '').trim());
    expect(hiding.length).toBeGreaterThan(0);
    const { container } = wrap(
      <>
        <UsageGroup />
        <Block title="Emptied by a search">{null}</Block>
      </>,
    );
    await screen.findByText('NVX Ancile usage');
    const usage = [...container.querySelectorAll('.u-view .setting-block')];
    expect(usage.length).toBe(4);
    for (const sel of hiding) {
      const hidden = [...container.querySelectorAll(sel)];
      for (const block of usage) expect(hidden).not.toContain(block);
      // The rule still does its job on a block of rows with none left.
      expect(hidden.length).toBe(1);
    }
  });
});

describe('Claude Code in NVX Ancile', () => {
  const totals = (i: number, o: number, c: number, answers: number) => ({
    input_tokens: i,
    output_tokens: o,
    cached_tokens: c,
    cost_usd: 0,
    answers,
  });

  it('says what will appear before Claude Code has answered here', async () => {
    mocked.get.mockResolvedValue({
      tz: 'UTC',
      today: totals(0, 0, 0, 0),
      week: totals(0, 0, 0, 0),
      cache_hit_rate: null,
      days: [],
      by_thread: [],
    });
    wrap(<ClaudeCodeMeasured />);
    expect(await screen.findByText(/No Claude Code answers in the last 7 days/)).toBeInTheDocument();
    expect(screen.getByText(/in a terminal session brought in here/)).toBeInTheDocument();
    expect(screen.getByText(/tokens in, out and from cache/)).toBeInTheDocument();
  });

  it('shows today, the week, the cache hit rate and the busiest threads', async () => {
    mocked.get.mockResolvedValue({
      tz: 'UTC',
      today: totals(1_000, 200, 3_000, 2),
      week: totals(4_000, 800, 12_000, 6),
      cache_hit_rate: 0.75,
      days: [],
      by_thread: [{ thread_id: 't1', title: 'Refactor the parser', ...totals(4_000, 800, 12_000, 6) }],
    });
    wrap(<ClaudeCodeMeasured />);
    expect(await screen.findByText('75%')).toBeInTheDocument();
    expect(screen.getByText('1.0k in · 200 out · 3.0k from cache')).toBeInTheDocument();
    expect(screen.getByText('Refactor the parser')).toBeInTheDocument();
    expect(mocked.get).toHaveBeenCalledWith(expect.stringMatching(/^\/claude-code\/usage\?tz=/));
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
