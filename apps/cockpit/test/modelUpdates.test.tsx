/**
 * ------------------------------------------------------------------
 *  Title    |  Model updates (MD4, MD5)
 *  Ref      |  packages/contracts/src/modelwatch.ts
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  Admin → Models says what the daily check found, each
 *           |  change has its action, Follow latest and Go back call
 *           |  the right endpoints, a too-soon check reads as an
 *           |  error, and a line that moved is toasted once.
 * ------------------------------------------------------------------
 */

import type { ModelChange, ModelWatchReport } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { demoWatch } from '../src/fixtures/demo';
import { ApiCallError, api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { forgetToasted, movedWords, useModelChangeToasts } from '../src/models/watch';
import { agoWords, ModelUpdates, providerStatus } from '../src/routes/admin/ModelUpdates';
import { useNotify } from '../src/state/notify';
import { useUi } from '../src/state/ui';

const mocked = api as unknown as Record<'get' | 'post' | 'put', ReturnType<typeof vi.fn>>;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const change = (c: Partial<ModelChange> & Pick<ModelChange, 'id' | 'kind' | 'model_id'>): ModelChange => ({
  line_id: 'anthropic/opus',
  before: null,
  after: null,
  reason: null,
  at: hoursAgo(1),
  seen: false,
  ...c,
});

/** The demo report, with the changes this test wants. */
const report = (changes: ModelChange[], p: Partial<ModelWatchReport> = {}): ModelWatchReport => ({
  ...demoWatch,
  changes,
  ...p,
});

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

function serve(r: ModelWatchReport) {
  mocked.get.mockImplementation(async (path: string) => {
    if (path === '/models/watch') return r;
    return {};
  });
}

beforeEach(() => {
  queryClient.clear();
  for (const f of Object.values(mocked)) f.mockReset();
  mocked.post.mockResolvedValue({});
  mocked.put.mockResolvedValue({});
  useUi.setState({ demo: false });
  useNotify.setState({ toasts: [], history: [] });
  forgetToasted();
});

describe('provider status', () => {
  it('says when it checked, when it could not, and when there is no live list', () => {
    const p = demoWatch.providers;
    expect(providerStatus(p[0]!, null).text).toBe('Checked 3 hours ago');
    expect(providerStatus({ ...p[0]!, checked_at: null }, null).text).toBe('Not checked yet');
    expect(
      providerStatus({ ...p[0]!, ok: false, error_title: 'Anthropic rejected the key' }, null).text,
    ).toBe('Anthropic rejected the key. Tries again later');
    expect(providerStatus(p[2]!, '2026-10-16').text).toBe(
      'No live list from Z.ai: prices as shipped on 16 Oct 2026',
    );
    expect(agoWords(hoursAgo(26))).toBe('yesterday');
  });
});

describe('Model updates', () => {
  it('renders each kind of change in plain words', async () => {
    const opus6 = 'anthropic/claude-opus-5-6';
    const sonnet = 'anthropic/claude-sonnet-5-5';
    serve(
      report([
        change({ id: 'a', kind: 'new_model', model_id: opus6 }),
        change({ id: 'b', kind: 'line_moved', model_id: opus6, reason: 'followed', after: opus6 }),
        change({
          id: 'c',
          kind: 'price',
          model_id: sonnet,
          line_id: 'anthropic/sonnet',
          before: { input_per_mtok: 3, output_per_mtok: 15 },
          after: { input_per_mtok: 2, output_per_mtok: 10 },
        }),
        change({ id: 'd', kind: 'context', model_id: sonnet, before: 200_000, after: 400_000 }),
        change({
          id: 'e',
          kind: 'capability',
          model_id: opus6,
          before: ['tools'],
          after: ['tools', 'vision', 'reasoning'],
        }),
        change({
          id: 'f',
          kind: 'unsupported_capability',
          model_id: opus6,
          before: [],
          after: ['pdf_input'],
        }),
        change({ id: 'g', kind: 'retired', model_id: 'anthropic/claude-opus-5-4' }),
      ]),
    );
    wrap(<ModelUpdates />);
    expect(await screen.findByText('New models')).toBeInTheDocument();
    expect(screen.getByText('Claude Opus 5.6 now answers where you chose Claude Opus.')).toBeInTheDocument();
    expect(
      screen.getByText(/Claude Sonnet 5.5: \$3 → \$2 in, \$15 → \$10 out per million/),
    ).toBeInTheDocument();
    expect(screen.getByText('from Anthropic', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/context 200,000 → 400,000 tokens/)).toBeInTheDocument();
    expect(screen.getByText(/now reads images, now thinks before answering/)).toBeInTheDocument();
    expect(screen.getByText(/pdf input/)).toBeInTheDocument();
    expect(screen.getByText('Not used by NVX Ancile yet')).toBeInTheDocument();
    expect(
      screen.getByText(/claude-opus-5-4 is retired\. Claude Opus 5.5 answers instead\./),
    ).toBeInTheDocument();
  });

  it('adds a new model, and goes back from a move', async () => {
    const opus6 = 'anthropic/claude-opus-5-6';
    serve(
      report(
        [
          change({ id: 'a', kind: 'new_model', model_id: opus6 }),
          change({ id: 'b', kind: 'line_moved', model_id: opus6, reason: 'followed', after: opus6 }),
        ],
        {
          lines: demoWatch.lines.map((l) =>
            l.id === 'anthropic/opus' ? { ...l, previous_id: 'anthropic/claude-opus-5-5' } : l,
          ),
        },
      ),
    );
    wrap(<ModelUpdates />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Claude Opus 5.6 to your models' }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/models/watch/add', { model_id: opus6 }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back to Claude Opus 5.5 for Claude Opus' }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/models/lines/anthropic/opus/back', {}));
  });

  it('follows a line, uses an offered model, and tries again after a failed test', async () => {
    serve(
      report([], {
        lines: [
          ...demoWatch.lines,
          {
            id: 'openai/mini',
            provider: 'openai',
            name: 'GPT mini',
            tier: 'balanced',
            latest_id: 'openai/gpt-5.5',
            current_id: 'openai/gpt-5.5',
            follow: true,
            previous_id: null,
            pending: {
              model_id: 'openai/gpt-5.5',
              state: 'failed',
              detail: 'The test call timed out.',
              at: hoursAgo(1),
            },
          },
          {
            id: 'anthropic/haiku',
            provider: 'anthropic',
            name: 'Claude Haiku',
            tier: 'fast',
            latest_id: null,
            current_id: 'anthropic/claude-sonnet-5-5',
            follow: true,
            previous_id: null,
            pending: {
              model_id: 'anthropic/claude-opus-5-6',
              state: 'testing',
              detail: null,
              at: hoursAgo(0),
            },
          },
        ],
      }),
    );
    wrap(<ModelUpdates />);
    // Offered: the hint and the Use it button.
    expect(await screen.findByText('Claude Opus 5.6 is out.')).toBeInTheDocument();
    expect(
      screen.getByText('Turn on Follow latest to move automatically after a test call'),
    ).toBeInTheDocument();
    expect(screen.getByText('Testing Claude Opus 5.6')).toBeInTheDocument();
    expect(screen.getByText('The test call timed out.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Follow latest for Claude Opus' }));
    await waitFor(() =>
      expect(mocked.put).toHaveBeenCalledWith('/models/lines/anthropic/opus', { follow: true }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Use Claude Opus 5.6 for Claude Opus' }));
    await waitFor(() =>
      expect(mocked.put).toHaveBeenCalledWith('/models/lines/anthropic/opus', {
        use: 'anthropic/claude-opus-5-6',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(mocked.post).toHaveBeenCalledWith('/models/watch/check', { provider: 'openai' }),
    );

    fireEvent.click(screen.getByRole('switch', { name: "Check prices against OpenRouter's public list" }));
    await waitFor(() =>
      expect(mocked.put).toHaveBeenCalledWith('/models/watch/settings', { openrouter_prices: false }),
    );
  });

  it('checks now with a busy state, and shows a too-soon error with its hint', async () => {
    serve(report([]));
    let release: () => void = () => undefined;
    mocked.post.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          release = () =>
            reject(
              new ApiCallError(429, {
                error: {
                  code: 'models.check_too_soon',
                  title: 'Checked a moment ago',
                  hint: 'Try again in a minute.',
                },
              } as never),
            );
        }),
    );
    wrap(<ModelUpdates />);
    const button = await screen.findByRole('button', { name: 'Check now' });
    fireEvent.click(button);
    const busy = await screen.findByRole('button', { name: 'Checking' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(mocked.post).toHaveBeenCalledWith('/models/watch/check', {});
    await act(async () => release());
    await waitFor(() =>
      expect(useNotify.getState().toasts.map((t) => t.title)).toContain('Checked a moment ago'),
    );
    expect(useNotify.getState().toasts[0]?.body).toBe('Try again in a minute.');
    expect(await screen.findByRole('button', { name: 'Check now' })).toBeEnabled();
  });

  it('says what to do when there are no providers', async () => {
    serve(report([], { providers: [], lines: [], models: [] }));
    wrap(<ModelUpdates />);
    expect(await screen.findByText('Add an API key to check its models daily.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  });

  it('marks the changes read after three seconds on screen', async () => {
    vi.useFakeTimers();
    const observers: ((e: { isIntersecting: boolean }[]) => void)[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      serve(report([change({ id: 'a', kind: 'new_model', model_id: 'anthropic/claude-opus-5-6' })]));
      wrap(<ModelUpdates />);
      await vi.waitFor(() => expect(observers.length).toBeGreaterThan(0));
      act(() => observers.at(-1)?.([{ isIntersecting: true }]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(mocked.post).toHaveBeenCalledWith('/models/watch/seen', { ids: ['a'] });
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('toasts for moves and retirements', () => {
  const moved = change({
    id: 'mv1',
    kind: 'line_moved',
    model_id: 'anthropic/claude-opus-5-6',
    reason: 'followed',
    after: 'anthropic/claude-opus-5-6',
  });

  function Host() {
    useModelChangeToasts();
    return null;
  }

  it('words them', () => {
    expect(movedWords(report([moved]), moved)).toBe(
      'Claude Opus 5.6 now answers where you chose Claude Opus.',
    );
    expect(
      movedWords(report([]), change({ id: 'x', kind: 'price', model_id: 'anthropic/claude-sonnet-5-5' })),
    ).toBeNull();
  });

  it('shows one toast per change, once per session, with Go back', async () => {
    serve(report([moved, change({ id: 'p', kind: 'price', model_id: 'anthropic/claude-sonnet-5-5' })]));
    const { unmount } = wrap(<Host />);
    await waitFor(() => expect(useNotify.getState().toasts).toHaveLength(1));
    const toast = useNotify.getState().toasts[0];
    expect(toast?.title).toBe('Claude Opus 5.6 now answers where you chose Claude Opus.');
    expect(toast?.action?.label).toBe('Go back');
    toast?.action?.run();
    await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/models/lines/anthropic/opus/back', {}));

    // Another event, same change: nothing more.
    useNotify.setState({ toasts: [] });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['model-watch'] });
    });
    unmount();
    wrap(<Host />);
    await waitFor(() => expect(mocked.get).toHaveBeenCalled());
    expect(useNotify.getState().toasts).toHaveLength(0);
  });
});
