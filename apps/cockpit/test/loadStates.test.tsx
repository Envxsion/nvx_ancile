/**
 * D4 on real panels: a read that failed shows what failed, in its own
 * words, with Try again; never the empty state ("No sources yet",
 * "Nothing running", "No workspace flow") and never the way to make one
 * ("Give it a flow", "Start a notebook"). Try again asks again, and a
 * refresh that failed under data keeps the data with a slim notice.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const params = vi.hoisted(() => ({}) as Record<string, string | undefined>);

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...real,
    useParams: () => params,
    useNavigate: () => vi.fn(),
    useRouterState: () => '/',
    useSearch: () => ({}),
    Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
  };
});
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { ActivityPanel } from '../src/activity/ActivityPanel';
import { useActivityPanel } from '../src/activity/api';
import { EvidencePanel } from '../src/drawer/EvidencePanel';
import { SourcesPanel } from '../src/drawer/SourcesPanel';
import * as demo from '../src/fixtures/demo';
import { FlowsScreen, NotebookFlowScreen } from '../src/flows/FlowsPage';
import { ApiCallError, api, localError } from '../src/lib/api';
import { keys } from '../src/lib/data';
import { queryClient } from '../src/lib/query';
import type { ThreadView } from '../src/lib/types';
import { ProSurfaceView } from '../src/pro/slot';
import { Rail } from '../src/shell/Rail';
import { useUi } from '../src/state/ui';

const get = vi.mocked(api.get);
const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

/** Core's answer that a retry will not help: still a read, so Try again is offered. */
const refused = (title = 'The notebook store is locked', status = 423) =>
  new ApiCallError(status, {
    error: {
      ...localError('store.locked', title, 'Close the other window, then try again.', 'd'.repeat(32)).error,
      retryable: false,
    },
  });

/** Answers by path; anything not listed is an empty list. */
function answer(routes: Record<string, () => unknown>) {
  get.mockImplementation(async (path: string) => {
    const route = routes[path];
    if (route) return route();
    return { items: [], next_cursor: null };
  });
}
const fail = (e: Error) => () => {
  throw e;
};

beforeAll(() => {
  // Hooks that retry (flows retry a 4xx too) do so at once here, not after seconds.
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0 } });
});
beforeEach(() => {
  for (const k of Object.keys(params)) delete params[k];
  useUi.setState({ demo: false, viewer: null });
  useActivityPanel.setState({ open: false, running: 0 });
  get.mockReset();
});
afterEach(() => {
  queryClient.clear();
});

const tryAgain = () => screen.getByRole('button', { name: 'Try again' });

describe('Sources panel', () => {
  it('shows what failed with Try again, not "No sources yet", and recovers on Try again', async () => {
    params.notebookId = 'nb_1';
    answer({ '/notebooks/nb_1/sources': fail(refused()) });
    wrap(<SourcesPanel />);
    expect(await screen.findByText('The notebook store is locked')).toBeInTheDocument();
    expect(screen.queryByText('No sources yet')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add sources' })).toBeNull();

    answer({ '/notebooks/nb_1/sources': () => ({ items: [] }) });
    fireEvent.click(tryAgain());
    expect(await screen.findByText('No sources yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the sources on screen when a refresh fails, with a slim notice', async () => {
    params.notebookId = 'nb_1';
    const first = demo.sources[0];
    if (!first) throw new Error('the demo has sources');
    queryClient.setQueryData(keys.sources('nb_1'), [first]);
    answer({ '/notebooks/nb_1/sources': fail(refused('The index is rebuilding')) });
    wrap(<SourcesPanel />);
    expect(screen.getByText(first.title)).toBeInTheDocument();
    await act(() => queryClient.refetchQueries({ queryKey: keys.sources('nb_1') }));
    expect(
      await screen.findByText(/Sources could not be loaded: The index is rebuilding/),
    ).toBeInTheDocument();
    expect(screen.getByText(first.title)).toBeInTheDocument();
    expect(tryAgain()).toBeInTheDocument();
  });
});

describe('Evidence panel', () => {
  const thread: ThreadView = {
    id: 't_1',
    title: 'A thread',
    notebookId: null,
    messages: [
      {
        id: 'm_1',
        parentId: null,
        role: 'assistant',
        blocks: [],
        parts: [{ type: 'text', text: 'An answer.' }],
        modelId: null,
        createdAt: new Date().toISOString(),
      },
    ],
  };

  it('a fact-check that did not load is not an offer to check', async () => {
    params.threadId = 't_1';
    queryClient.setQueryData(keys.thread('t_1'), thread);
    answer({ '/messages/m_1/factcheck': fail(refused('The judge store is locked')) });
    wrap(<EvidencePanel />);
    expect(await screen.findByText('The judge store is locked')).toBeInTheDocument();
    expect(screen.queryByText('Not fact-checked yet')).toBeNull();
    expect(screen.queryByRole('button', { name: /Fact-check this answer/ })).toBeNull();
    expect(tryAgain()).toBeInTheDocument();
  });

  it('a check that was never made (404) still offers to make one', async () => {
    params.threadId = 't_1';
    queryClient.setQueryData(keys.thread('t_1'), thread);
    answer({ '/messages/m_1/factcheck': fail(refused('No check', 404)) });
    wrap(<EvidencePanel />);
    expect(await screen.findByText('Not fact-checked yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a thread that did not load is not "Ask something"', async () => {
    params.threadId = 't_2';
    get.mockRejectedValue(refused('The thread store is locked'));
    wrap(<EvidencePanel />);
    expect(await screen.findByText('The thread store is locked')).toBeInTheDocument();
    expect(screen.queryByText(/Ask something, then fact-check/)).toBeNull();
  });
});

describe('Activity panel', () => {
  it('not knowing what runs is not "Nothing running"', async () => {
    useActivityPanel.setState({ open: true });
    answer({ '/activity': fail(refused('Activity is unavailable')) });
    wrap(<ActivityPanel />);
    expect(await screen.findByText('Activity is unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Nothing running')).toBeNull();
    expect(tryAgain()).toBeInTheDocument();
  });
});

describe('Flows', () => {
  it('a generic failure shows what failed, not the empty lists, and makes nothing', async () => {
    answer({ '/flows': fail(refused('The flow store is locked')) });
    wrap(<FlowsScreen />);
    expect(await screen.findByText('The flow store is locked')).toBeInTheDocument();
    expect(screen.queryByText(/No workspace flow/)).toBeNull();
    expect(screen.queryByText(/No notebook has its own flow/)).toBeNull();
    // A new flow would be made the default while the real one is unknown.
    expect(screen.getByRole('button', { name: /New flow/ })).toBeDisabled();
    expect(tryAgain()).toBeInTheDocument();
  });

  it('a Core without flows still says so, as before', async () => {
    answer({ '/flows': fail(refused('Not here', 405)) });
    wrap(<FlowsScreen />);
    expect(await screen.findByText('Flows need a newer Core')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a notebook whose flows did not load is not offered "Give it a flow"', async () => {
    params.notebookId = 'nb_1';
    answer({ '/flows?scope=notebook&ref=nb_1': fail(refused('The flow store is locked')) });
    wrap(<NotebookFlowScreen />);
    expect(await screen.findByText('The flow store is locked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Give it a flow' })).toBeNull();
    expect(screen.queryByText(/has no flow of its own/)).toBeNull();

    answer({ '/flows?scope=notebook&ref=nb_1': () => ({ items: [] }) });
    fireEvent.click(tryAgain());
    expect(await screen.findByRole('button', { name: 'Give it a flow' })).toBeInTheDocument();
  });
});

describe('A Pro surface', () => {
  it('a licence that did not load is not "part of Pro"', async () => {
    answer({ '/license/details': fail(refused('The licence file is unreadable')) });
    wrap(<ProSurfaceView id="fleet" />);
    expect(await screen.findByText('The licence file is unreadable')).toBeInTheDocument();
    expect(screen.queryByText(/part of NVX Ancile Pro/)).toBeNull();

    // Once it answers, the card is the right one again (this test build has no Pro screens).
    answer({ '/license/details': () => ({ build: 'free', features: [] }) });
    fireEvent.click(tryAgain());
    expect(await screen.findByText(/which this build does not include/)).toBeInTheDocument();
  });
});

describe('The rail', () => {
  it('notebooks that did not load say so with Try again, not "Start a notebook"', async () => {
    answer({ '/notebooks': fail(refused('The notebook store is locked')) });
    wrap(<Rail />);
    expect(await screen.findByText('The notebook store is locked')).toBeInTheDocument();
    expect(screen.queryByText("Start a notebook for a project's sources")).toBeNull();
    expect(screen.queryByText(/Your threads will gather here/)).toBeNull();

    answer({});
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText("Start a notebook for a project's sources")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('The notebook store is locked')).toBeNull());
  });

  it('threads that did not load say what failed, in its own words', async () => {
    answer({ '/threads?limit=100': fail(refused('The thread store is locked')) });
    wrap(<Rail />);
    expect(await screen.findByText('The thread store is locked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
