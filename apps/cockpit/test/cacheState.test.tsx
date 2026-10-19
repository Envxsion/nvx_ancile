/**
 * ------------------------------------------------------------------
 *  Title    |  Prompt cache cues
 *  Ref      |  ROADMAP.md CA12
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  The warm mark in the model picker (shows, fades, goes,
 *           |  says "probably" for guesses, matches alias entries) and
 *           |  the one-line price tag before a switch (key, plan, local
 *           |  wording, short threads, close per thread and model, demo,
 *           |  a 404 as "no information").
 * ------------------------------------------------------------------
 */

import type { CacheState, CacheStateItem } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => undefined,
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { modelGroups } from '../src/engines/api';
import { ModelMenu } from '../src/engines/ModelMenu';
import { ApiCallError, api } from '../src/lib/api';
import { keys } from '../src/lib/data';
import { queryClient } from '../src/lib/query';
import type { MessageView, ModelView, ThreadView } from '../src/lib/types';
import {
  cacheKeys,
  demoCacheState,
  switchCostLine,
  tokensShort,
  useSwitchCostDismissed,
  warmOpacity,
  warmWords,
} from '../src/models/cacheState';
import { SwitchCostNotice } from '../src/models/SwitchCostNotice';
import { useUi } from '../src/state/ui';

const mocked = api as unknown as Record<'get', ReturnType<typeof vi.fn>>;
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

const model = (p: Partial<ModelView> & Pick<ModelView, 'id' | 'name'>): ModelView => ({
  provider: 'x',
  hue: 'azure',
  via: 'direct',
  contextWindow: 100_000,
  status: 'ready',
  local: false,
  ...p,
});
const MODELS: ModelView[] = [
  model({ id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }),
  model({ id: 'anthropic/sonnet:latest', name: 'Claude Sonnet', aliasOf: 'anthropic/claude-sonnet-5-5' }),
  model({ id: 'openai/gpt-5.5', name: 'GPT-5.5' }),
  model({ id: 'ollama/qwen3:14b', name: 'Qwen3 14B', local: true }),
];

const NOW = Date.parse('2026-10-19T10:00:00Z');
const item = (p: Partial<CacheStateItem> & Pick<CacheStateItem, 'model_id'>): CacheStateItem => ({
  provider: 'x',
  warm_until: null,
  prefix_tokens: 84_000,
  cold_cost_usd: 0.25,
  reported: true,
  ...p,
});
const minutes = (n: number) => new Date(NOW + n * 60_000).toISOString();

describe('wording', () => {
  it('formats tokens and words the warm time', () => {
    expect(tokensShort(84_000)).toBe('84k');
    expect(tokensShort(1500)).toBe('1.5k');
    expect(tokensShort(620)).toBe('620');
    const i = item({ model_id: 'a' });
    expect(warmWords(i, 3 * 60_000)).toBe('Has this thread cached for about 3 more minutes');
    expect(warmWords(i, 60_000)).toBe('Has this thread cached for about 1 more minute');
    expect(warmWords(i, 20_000)).toBe('Has this thread cached for less than a minute');
    expect(warmWords({ ...i, reported: false }, 3 * 60_000)).toBe(
      'Probably has this thread cached for about 3 more minutes',
    );
    expect(warmWords({ ...i, ttl_assumed: true }, 3 * 60_000)).toMatch(/^Probably has/);
  });

  it('fades linearly towards the end', () => {
    expect(warmOpacity(10 * 60_000)).toBe(1);
    expect(warmOpacity(150_000)).toBeCloseTo(0.65, 2);
    expect(warmOpacity(0)).toBe(0.3);
  });

  it('words the price tag for key, plan and local models, and hides noise', () => {
    const base = { warm: false, prefix_tokens: 84_000, cold_cost_usd: 0.25 };
    expect(switchCostLine(base)).toBe('Re-reads 84k tokens: about $0.25, first reply slower');
    expect(switchCostLine({ ...base, cold_cost_usd: null, plan: true })).toBe(
      'Re-reads 84k tokens on your plan, first reply slower',
    );
    expect(switchCostLine({ ...base, cold_cost_usd: null, local: true })).toBe(
      'Re-reads 84k tokens, first reply slower',
    );
    expect(switchCostLine({ ...base, prefix_tokens: 1023 })).toBeNull();
    expect(switchCostLine({ ...base, cold_cost_usd: 0.0004 })).toBeNull();
    expect(switchCostLine({ ...base, cold_cost_usd: null })).toBeNull();
    expect(switchCostLine({ ...base, warm: true })).toBeNull();
    expect(switchCostLine(null)).toBeNull();
  });
});

describe('the warm mark in the picker', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    queryClient.clear();
    mocked.get.mockReset();
    useUi.setState({ demo: false });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const open = (items: CacheStateItem[], currentId: string | null = null) => {
    queryClient.setQueryData<CacheState>(cacheKeys.thread('thr_1'), { items, thread_tokens: 84_000 });
    const groups = modelGroups({ models: MODELS, engines: undefined, scope: null, session: null, currentId });
    wrap(
      <ModelMenu
        open
        groups={groups}
        onPick={() => {}}
        threadId="thr_1"
        trigger={<button type="button">Model</button>}
      />,
    );
    return screen.getByRole('menu');
  };
  const rowOf = (menu: HTMLElement, name: string) =>
    within(menu).getByText(name).closest('[role="menuitem"]') as HTMLElement;

  it('marks a warm model, says how long, and leaves cold ones bare', () => {
    const menu = open([
      item({ model_id: 'openai/gpt-5.5', warm_until: minutes(3) }),
      item({ model_id: 'ollama/qwen3:14b', warm_until: minutes(-1) }),
    ]);
    const mark = within(rowOf(menu, 'GPT-5.5')).getByRole('img');
    expect(mark).toHaveAccessibleName('Has this thread cached for about 3 more minutes');
    expect(mark).toHaveAttribute('title', 'Has this thread cached for about 3 more minutes');
    expect(within(rowOf(menu, 'Qwen3 14B')).queryByRole('img')).toBeNull();
    expect(within(rowOf(menu, 'Claude Sonnet')).queryByRole('img')).toBeNull();
  });

  it('says "probably" when the provider reports no cache use', () => {
    const menu = open([item({ model_id: 'openai/gpt-5.5', warm_until: minutes(2), reported: false })]);
    expect(within(rowOf(menu, 'GPT-5.5')).getByRole('img').getAttribute('aria-label')).toMatch(
      /^Probably has this thread cached/,
    );
  });

  it('matches a "latest" entry to the concrete model it answers with', () => {
    const menu = open([item({ model_id: 'anthropic/claude-sonnet-5-5', warm_until: minutes(4) })]);
    expect(within(rowOf(menu, 'Claude Sonnet')).getByRole('img')).toBeInTheDocument();
  });

  it('fades as time passes and goes when the cache runs out', () => {
    const menu = open([item({ model_id: 'openai/gpt-5.5', warm_until: minutes(5) })]);
    const mark = () => within(rowOf(menu, 'GPT-5.5')).queryByRole('img');
    expect(mark()?.style.opacity).toBe('1');
    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    const faded = Number(mark()?.style.opacity);
    expect(faded).toBeGreaterThan(0.3);
    expect(faded).toBeLessThan(1);
    expect(mark()).toHaveAccessibleName('Has this thread cached for about 2 more minutes');
    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(mark()).toBeNull();
  });
});

describe('the switch-cost line', () => {
  const answer = (id: string, modelId: string): MessageView => ({
    id,
    parentId: null,
    role: 'assistant',
    blocks: [],
    modelId,
    createdAt: new Date(NOW).toISOString(),
  });
  const seed = (lastModel: string, modelNow: string, answered = true) => {
    queryClient.setQueryData(keys.models, MODELS);
    queryClient.setQueryData<ThreadView>(keys.thread('thr_1'), {
      id: 'thr_1',
      title: 't',
      notebookId: null,
      model: modelNow,
      messages: answered ? [answer('m1', lastModel)] : [],
    } as unknown as ThreadView);
  };
  const reply = (candidate: Record<string, unknown>, items: CacheStateItem[] = []) =>
    mocked.get.mockImplementation((path: string) =>
      path.includes('candidate=')
        ? Promise.resolve({
            items,
            thread_tokens: 84_000,
            candidate: { model_id: 'openai/gpt-5.5', warm: false, prefix_tokens: 84_000, ...candidate },
          })
        : Promise.resolve(null),
    );

  beforeEach(() => {
    queryClient.clear();
    mocked.get.mockReset();
    useUi.setState({ demo: false });
    useSwitchCostDismissed.setState({ closed: {} });
  });
  afterEach(() => cleanup());

  it('prices a cold key model', async () => {
    seed('anthropic/claude-sonnet-5-5', 'openai/gpt-5.5');
    reply({ cold_cost_usd: 0.25 });
    wrap(<SwitchCostNotice threadId="thr_1" />);
    expect(
      await screen.findByText('Re-reads 84k tokens: about $0.25, first reply slower'),
    ).toBeInTheDocument();
    expect(mocked.get).toHaveBeenCalledWith('/threads/thr_1/cache-state?candidate=openai%2Fgpt-5.5');
  });

  it('says plan use for a plan model and time only for a local one', async () => {
    seed('anthropic/claude-sonnet-5-5', 'openai/gpt-5.5');
    reply({ cold_cost_usd: null, plan: true });
    wrap(<SwitchCostNotice threadId="thr_1" />);
    expect(
      await screen.findByText('Re-reads 84k tokens on your plan, first reply slower'),
    ).toBeInTheDocument();
    cleanup();
    queryClient.clear();
    seed('anthropic/claude-sonnet-5-5', 'ollama/qwen3:14b');
    reply({ model_id: 'ollama/qwen3:14b', cold_cost_usd: null, local: true });
    wrap(<SwitchCostNotice threadId="thr_1" />);
    expect(await screen.findByText('Re-reads 84k tokens, first reply slower')).toBeInTheDocument();
  });

  it('shows nothing for a short thread, a warm model, the same model, or an unanswered thread', async () => {
    seed('anthropic/claude-sonnet-5-5', 'openai/gpt-5.5');
    reply({ prefix_tokens: 900, cold_cost_usd: 0.01 });
    wrap(<SwitchCostNotice threadId="thr_1" />);
    await waitFor(() => expect(mocked.get).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();

    queryClient.clear();
    seed('anthropic/claude-sonnet-5-5', 'openai/gpt-5.5');
    reply({ warm: true, cold_cost_usd: 0.25 });
    wrap(<SwitchCostNotice threadId="thr_1" />);
    await waitFor(() => expect(mocked.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();

    mocked.get.mockClear();
    queryClient.clear();
    seed('openai/gpt-5.5', 'openai/gpt-5.5');
    reply({ cold_cost_usd: 0.25 });
    wrap(<SwitchCostNotice threadId="thr_1" />);
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();

    queryClient.clear();
    seed('', 'openai/gpt-5.5', false);
    wrap(<SwitchCostNotice threadId="thr_1" />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(mocked.get).not.toHaveBeenCalled();
  });

  it('closes for that thread and model only', async () => {
    seed('anthropic/claude-sonnet-5-5', 'openai/gpt-5.5');
    reply({ cold_cost_usd: 0.25 });
    wrap(<SwitchCostNotice threadId="thr_1" />);
    await screen.findByRole('status');
    fireEvent.click(screen.getByRole('button', { name: 'Hide this note for GPT-5.5' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(useSwitchCostDismissed.getState().closed).toEqual({ 'thr_1|openai/gpt-5.5': true });
    // Another model in the same thread still gets its line.
    reply({ model_id: 'ollama/qwen3:14b', cold_cost_usd: null, local: true });
    act(() => {
      queryClient.setQueryData<ThreadView>(keys.thread('thr_1'), (t) => ({
        ...(t as ThreadView),
        model: 'ollama/qwen3:14b',
      }));
    });
    expect(await screen.findByText('Re-reads 84k tokens, first reply slower')).toBeInTheDocument();
  });

  it('treats a 404 as no information', async () => {
    seed('anthropic/claude-sonnet-5-5', 'openai/gpt-5.5');
    mocked.get.mockRejectedValue(
      new ApiCallError(404, {
        error: {
          code: 'not_found',
          title: 'No such thread',
          hint: 'x',
          retryable: false,
          trace_id: 't',
          attempts: [],
        },
      } as never),
    );
    wrap(<SwitchCostNotice threadId="thr_1" />);
    await waitFor(() => expect(mocked.get).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('uses the fixture in demo mode and calls nothing', async () => {
    useUi.setState({ demo: true });
    seed('anthropic/claude-sonnet-5-5', 'openai/gpt-5.5');
    wrap(<SwitchCostNotice threadId="thr_1" />);
    expect(
      await screen.findByText('Re-reads 84k tokens: about $0.42, first reply slower'),
    ).toBeInTheDocument();
    expect(mocked.get).not.toHaveBeenCalled();
    expect(demoCacheState(NOW).items[0]?.warm_until).toBe(minutes(3));
  });
});
