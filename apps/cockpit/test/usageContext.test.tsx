/**
 * U1 and U2: Settings → Usage shows the live context of the thread you
 * last had open (Claude Code's own count in a Claude Code thread), says
 * why each block is empty, counts Claude Code sessions brought in from the
 * terminal, and every Claude Code cost reads "Included in your Claude plan"
 * (or names where an API sign-in bills).
 */
import type { ClaudeCodeUsage, PathBudget, UsageReport } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
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

import { ApiCallError, api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { useUi } from '../src/state/ui';
import { costText } from '../src/thread/Message';
import { LiveContext } from '../src/usage/LiveContext';
import { billedTo, claudeCodeCostWords, IN_PLAN, isClaudeCodeAnswer } from '../src/usage/planCost';
import { AncileUsage, ClaudeCodeMeasured } from '../src/usage/UsageView';

const mocked = api as unknown as Record<'get', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

/** GET /threads/:id (the last page): the thread and its messages. */
const thread = (settings: Record<string, unknown> = {}) => ({
  thread: {
    id: 'thr_1',
    workspace_id: 'w',
    notebook_id: null,
    title: 'Refactor the parser',
    title_source: 'auto',
    settings,
    active_head_id: null,
    root_message_id: null,
    created_at: '2026-10-14T10:00:00Z',
    updated_at: '2026-10-14T10:00:00Z',
  },
  messages: [],
  head_id: null,
  total: 0,
  has_more: false,
  active_run: null,
});
/** The thread's own read, not its context budget or Claude Code's live state. */
const isThread = (path: string) => path.startsWith('/threads/thr_1/path');
const budget = (over: Partial<PathBudget> = {}): PathBudget =>
  ({
    head_id: 'm1',
    model_id: 'openai/gpt-5',
    window: 200_000,
    used: { system: 2_000, memory: 1_000, retrieval: 6_000, history: 150_000, reserve_output: 8_000 },
    total: 167_000,
    ratio: 0.835,
    level: 'warn',
    compaction: null,
    compactable: 12,
    compacts_at: 0.95,
    ...over,
  }) as PathBudget;
const notFound = () =>
  new ApiCallError(404, {
    error: {
      code: 'thread.not_found',
      title: 'Thread not found',
      hint: '',
      retryable: false,
      trace_id: 't',
      attempts: [],
      context: {},
    },
  });

beforeEach(() => {
  queryClient.clear();
  mocked.get.mockReset();
  useUi.setState({ demo: false, lastThreadId: null });
});

describe('Context now', () => {
  it('says what it will show before a thread has been open', () => {
    wrap(<LiveContext />);
    expect(screen.getByText('No thread open yet.')).toBeInTheDocument();
    expect(screen.getByText(/how full its context is for the model that answers it/)).toBeInTheDocument();
    expect(mocked.get).not.toHaveBeenCalled();
  });

  it("shows the last thread's branch: the meter, what fills it, and Compact when it is filling up", async () => {
    useUi.setState({ lastThreadId: 'thr_1' });
    mocked.get.mockImplementation(async (path: string) =>
      isThread(path) ? thread() : path === '/threads/thr_1/context-budget' ? budget() : null,
    );
    wrap(<LiveContext />);
    expect(await screen.findByText('84% of context: compacts at 95%')).toBeInTheDocument();
    expect(screen.getByText('Refactor the parser')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('150k')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compact older messages' })).toBeInTheDocument();
  });

  it('offers no Compact while there is room, and explains a model with no known window', async () => {
    useUi.setState({ lastThreadId: 'thr_1' });
    mocked.get.mockImplementation(async (path: string) =>
      isThread(path) ? thread() : budget({ window: 0, ratio: 0, level: 'ok', total: 0 }),
    );
    wrap(<LiveContext />);
    expect(await screen.findByText(/does not say how large its context is/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Compact older messages' })).toBeNull();
  });

  it("uses Claude Code's own count in a Claude Code thread, and says when its session is not open", async () => {
    useUi.setState({ lastThreadId: 'thr_1' });
    let ctx: unknown = null;
    mocked.get.mockImplementation(async (path: string) =>
      isThread(path)
        ? thread({ claude_code: { session_id: 's', cwd: '/repo' } })
        : path.endsWith('/live')
          ? { state: 'idle', context: ctx }
          : null,
    );
    const first = wrap(<LiveContext />);
    expect(await screen.findByText(/reports its own context once its session is open/)).toBeInTheDocument();
    // Never Ancile's estimate for a Claude Code thread.
    expect(mocked.get.mock.calls.map((c) => c[0])).not.toContain('/threads/thr_1/context-budget');
    first.unmount();

    queryClient.clear();
    ctx = { used_tokens: 90_000, max_tokens: 200_000, percent: 45, compacts_at: 92 };
    wrap(<LiveContext />);
    expect(await screen.findByText('45% of context: compacts at 92%')).toBeInTheDocument();
    expect(screen.getByText(/Claude Code's own count: 90k of 200k tokens/)).toBeInTheDocument();
  });

  it('says the thread is gone after it was deleted, and offers Try again on any other failure', async () => {
    useUi.setState({ lastThreadId: 'thr_1' });
    mocked.get.mockRejectedValue(notFound());
    const first = wrap(<LiveContext />);
    expect(await screen.findByText('The thread you last had open is gone.')).toBeInTheDocument();
    first.unmount();

    queryClient.clear();
    mocked.get.mockReset();
    mocked.get.mockImplementation(async (path: string) => {
      if (isThread(path)) return thread();
      throw new Error('socket hang up');
    });
    wrap(<LiveContext />);
    const retry = await screen.findByRole('button', { name: /Try again/ }, { timeout: 4000 });
    expect(screen.getByText("This thread's context could not be loaded")).toBeInTheDocument();
    mocked.get.mockImplementation(async (path: string) => (isThread(path) ? thread() : budget()));
    fireEvent.click(retry);
    expect(await screen.findByText('84% of context: compacts at 95%')).toBeInTheDocument();
  });
});

const totals = (i: number, answers: number) => ({
  input_tokens: i,
  output_tokens: 0,
  cached_tokens: 0,
  cost_usd: 0,
  answers,
});
const ccUsage = (over: Partial<ClaudeCodeUsage> = {}): ClaudeCodeUsage => ({
  tz: 'UTC',
  today: totals(100, 1),
  week: totals(9_000, 4),
  cache_hit_rate: 0,
  days: [],
  by_thread: [],
  imported: { ...totals(6_000, 3), sessions: 2 },
  ...over,
});

describe('Claude Code in NVX Ancile', () => {
  it('counts sessions brought in from the terminal, and says when no thread stands out', async () => {
    mocked.get.mockResolvedValue(ccUsage());
    wrap(<ClaudeCodeMeasured />);
    expect(
      await screen.findByText('Includes 6.0k tokens from 2 sessions run in the terminal and brought in.'),
    ).toBeInTheDocument();
    expect(screen.getByText('No single thread stands out this week.')).toBeInTheDocument();
  });

  it('says when nothing came from the terminal, and how it would', async () => {
    mocked.get.mockResolvedValue(ccUsage({ imported: { ...totals(0, 0), sessions: 0 } }));
    wrap(<ClaudeCodeMeasured />);
    expect(
      await screen.findByText(/A session run in the terminal counts too once it is brought in/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See sessions' })).toBeInTheDocument();
  });

  it('offers Try again when its usage could not be read', async () => {
    mocked.get.mockRejectedValue(new Error('socket hang up'));
    wrap(<ClaudeCodeMeasured />);
    expect(
      await screen.findByText("Claude Code's usage could not be loaded", {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    mocked.get.mockResolvedValue(ccUsage());
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText(/sessions run in the terminal and brought in/)).toBeInTheDocument();
  });
});

const report = (over: Partial<UsageReport> = {}): UsageReport =>
  ({
    range: 'day',
    tz: 'UTC',
    from: '2026-10-14T00:00:00Z',
    to: '2026-10-15T00:00:00Z',
    bucket: 'hour',
    totals: { input_tokens: 9_000, output_tokens: 1_000, cached_tokens: 0, cost_usd: 0.5, answers: 3 },
    estimated_cost_usd: 0.4,
    series: [],
    by_engine: [
      {
        engine: 'claude_code',
        input_tokens: 8_000,
        output_tokens: 500,
        cached_tokens: 0,
        cost_usd: 0.4,
        answers: 2,
      },
      {
        engine: 'gateway',
        input_tokens: 1_000,
        output_tokens: 500,
        cached_tokens: 0,
        cost_usd: 0.1,
        answers: 1,
      },
    ],
    by_model: [],
    by_provider: [],
    ...over,
  }) as UsageReport;

/** GET /claude-code/status, as much of it as billing reads. */
const status = (auth_method: string) => ({
  installed: true,
  signed_in: true,
  auth_method,
  install: { state: 'idle' },
});
const total = (c: HTMLElement) => c.querySelector('.u-totals') as HTMLElement;

describe('NVX Ancile usage', () => {
  it("keeps Claude Code's estimate out of the total when the Claude plan covers it, and marks its row", async () => {
    mocked.get.mockResolvedValue(status('claude.ai'));
    const { container } = wrap(<AncileUsage report={report()} />);
    expect(total(container)).toHaveTextContent('Estimated cost$0.10');
    expect(
      screen.getByText(/Claude Code is included in your Claude plan \(about \$0.40/),
    ).toBeInTheDocument();
    const engines = screen.getByRole('region', { name: 'By engine' });
    expect(engines).toHaveTextContent('In plan');
    expect(engines).toHaveTextContent(IN_PLAN);
  });

  it('counts it as billed when Claude Code is signed in with an API key', async () => {
    mocked.get.mockResolvedValue(status('api_key'));
    const { container } = wrap(<AncileUsage report={report()} />);
    await waitFor(() => expect(total(container)).toHaveTextContent('Estimated cost$0.50'));
    expect(screen.getByText(/billed to your Anthropic API key/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'By engine' })).not.toHaveTextContent('In plan'),
    );
  });

  it('says what the breakdowns will show before anything answered, and when a provider served nothing', () => {
    const empty = report({
      totals: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cost_usd: 0, answers: 0 },
      estimated_cost_usd: 0,
      by_engine: [],
    });
    const first = wrap(<AncileUsage report={empty} />);
    expect(screen.getByText(/split here by engine, by model and by OpenRouter provider/)).toBeInTheDocument();
    first.unmount();
    wrap(<AncileUsage report={empty} provider="Groq" />);
    expect(screen.getByText('Nothing served by Groq in this range.')).toBeInTheDocument();
  });
});

describe('a Claude Code cost, in words', () => {
  it('is included in the plan, whatever Claude Code estimated, unless an API sign-in bills it', () => {
    expect(claudeCodeCostWords(0.42, null)).toBe(IN_PLAN);
    expect(claudeCodeCostWords(0, null)).toBe(IN_PLAN);
    expect(claudeCodeCostWords(0.42, billedTo('api_key'))).toBe(
      'About $0.42, billed to your Anthropic API key',
    );
    expect(claudeCodeCostWords(0.042, billedTo('Bedrock'))).toBe('About $0.042, billed to Amazon Bedrock');
    expect(claudeCodeCostWords(0, billedTo('vertex'))).toBe('Billed to Google Vertex AI');
    // A Claude account, and not known yet, are both the plan.
    expect(billedTo('claude.ai')).toBeNull();
    expect(billedTo(null)).toBeNull();
  });

  it('applies to an answer in a Claude Code thread as well as to Claude Code as a model', () => {
    expect(
      isClaudeCodeAnswer({ modelId: 'claude-opus-5-5', provenance: { claude_code: { session_id: 's' } } }),
    ).toBe(true);
    expect(isClaudeCodeAnswer({ modelId: 'claude-code/opus', provenance: {} })).toBe(true);
    expect(isClaudeCodeAnswer({ modelId: 'anthropic/claude-opus-5-5', provenance: {} })).toBe(false);
    // A live Claude Code turn records an estimate; it still reads as the plan, never "$0.120".
    expect(costText(0.12, 'claude-opus-5-5', { answer: true, billedTo: null })).toBe(IN_PLAN);
    expect(costText(0.12, 'claude-code/opus')).toBe(IN_PLAN);
    expect(costText(0.12, 'openai/gpt-5')).toBe('$0.12');
  });
});
