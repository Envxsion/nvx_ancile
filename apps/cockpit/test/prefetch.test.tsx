/**
 * ------------------------------------------------------------------
 *  Title    |  Data fetched ahead of a click
 *  Ref      |  ROADMAP P5
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  Resting on a link to a thread or notebook fetches its
 *           |  data once, after a short delay; passing over it, or
 *           |  merely having it on screen, fetches nothing; and none
 *           |  of it happens offline, in the sample workspace, or for
 *           |  a thread that is gone.
 *  How      |  A small router with the real loaders and the real delay,
 *           |  300 links, and the query client's prefetchQuery watched.
 * ------------------------------------------------------------------
 */

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { ApiCallError, api, localError } from '../src/lib/api';
import { useConnection } from '../src/lib/connection';
import { keys } from '../src/lib/data';
import {
  loadNotebook,
  loadThread,
  PRELOAD_DELAY_MS,
  paletteTarget,
  prefetchNotebook,
  prefetchThread,
} from '../src/lib/prefetch';
import { queryClient } from '../src/lib/query';
import { useUi } from '../src/state/ui';

const get = vi.mocked(api.get);

function testRouter() {
  const root = createRootRoute({
    component: () => (
      <>
        <ul>
          {Array.from({ length: 300 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
            <li key={i}>
              <Link to="/t/$threadId" params={{ threadId: `t${i}` }}>
                Thread {i}
              </Link>
            </li>
          ))}
          <li>
            <Link to="/n/$notebookId" params={{ notebookId: 'nb1' }}>
              Notebook one
            </Link>
          </li>
        </ul>
        <Outlet />
      </>
    ),
  });
  const thread = createRoute({
    getParentRoute: () => root,
    path: '/t/$threadId',
    component: () => <p>thread open</p>,
    loader: loadThread,
  });
  const notebook = createRoute({
    getParentRoute: () => root,
    path: '/n/$notebookId',
    component: () => <p>notebook open</p>,
    loader: loadNotebook,
  });
  const index = createRoute({ getParentRoute: () => root, path: '/', component: () => null });
  return createRouter({
    routeTree: root.addChildren([index, thread, notebook]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
    defaultPreload: 'intent',
    defaultPreloadDelay: PRELOAD_DELAY_MS,
  });
}

let prefetch: MockInstance<typeof queryClient.prefetchQuery>;
beforeEach(() => {
  // jsdom has no scrolling; the router restores scroll after a load.
  window.scrollTo = vi.fn();
  vi.useFakeTimers();
  get.mockReset();
  get.mockResolvedValue({ items: [] });
  useUi.setState({ demo: false });
  useConnection.setState({ status: 'online', failures: 0 });
  prefetch = vi.spyOn(queryClient, 'prefetchQuery');
});
afterEach(() => {
  vi.useRealTimers();
  prefetch.mockRestore();
  queryClient.clear();
});

const keysOf = () => prefetch.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);

async function mount() {
  const router = testRouter();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return router;
}

describe('hovering a link', () => {
  it('fetches nothing for rows that are only on screen', async () => {
    await mount();
    expect(screen.getAllByRole('link')).toHaveLength(301);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(prefetch).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('fetches a thread once, after the delay, with the key the thread screen uses', async () => {
    await mount();
    fireEvent.mouseEnter(screen.getByRole('link', { name: 'Thread 7' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRELOAD_DELAY_MS - 30);
    });
    expect(prefetch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    expect(keysOf()).toEqual([keys.thread('t7')]);
    // Resting there longer, or coming back to it, does not fetch again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    fireEvent.mouseLeave(screen.getByRole('link', { name: 'Thread 7' }));
    fireEvent.mouseEnter(screen.getByRole('link', { name: 'Thread 7' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRELOAD_DELAY_MS + 50);
    });
    expect(keysOf()).toHaveLength(1);
  });

  it('fetches nothing when the pointer passes over and leaves before the delay', async () => {
    await mount();
    const link = screen.getByRole('link', { name: 'Thread 9' });
    fireEvent.mouseEnter(link);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRELOAD_DELAY_MS / 3);
    });
    fireEvent.mouseLeave(link);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(prefetch).not.toHaveBeenCalled();
  });

  it('fetches on keyboard focus too', async () => {
    await mount();
    fireEvent.focus(screen.getByRole('link', { name: 'Thread 3' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRELOAD_DELAY_MS + 50);
    });
    expect(keysOf()).toEqual([keys.thread('t3')]);
  });

  it('fetches a notebook’s sources and notes', async () => {
    await mount();
    fireEvent.mouseEnter(screen.getByRole('link', { name: 'Notebook one' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PRELOAD_DELAY_MS + 50);
    });
    expect(keysOf()).toEqual([keys.sources('nb1'), keys.notes('nb1')]);
  });
});

describe('when there is nothing to fetch', () => {
  it('skips the sample workspace, an offline Core, and a missing id', () => {
    useUi.setState({ demo: true });
    prefetchThread('t1');
    prefetchNotebook('nb1');
    useUi.setState({ demo: false });
    useConnection.setState({ status: 'offline' });
    prefetchThread('t1');
    prefetchNotebook('nb1');
    useConnection.setState({ status: 'online' });
    prefetchThread(undefined);
    prefetchNotebook('');
    expect(prefetch).not.toHaveBeenCalled();
  });

  it('leaves the cache alone for a thread that is gone or that you may not read', async () => {
    const gone = (status: number, code: string) =>
      new ApiCallError(status, {
        error: {
          ...localError(code, 'No such thread', 'Choose another.', 'a'.repeat(32)).error,
          retryable: false,
        },
      });
    for (const e of [gone(404, 'thread.not_found'), gone(403, 'permission.denied')]) {
      get.mockRejectedValueOnce(e);
      prefetchThread('t_gone');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      // No data, no crash, and the screen's own error is what a click then shows.
      expect(queryClient.getQueryData(keys.thread('t_gone'))).toBeUndefined();
      queryClient.clear();
    }
  });
});

describe('the palette’s highlighted item', () => {
  it('names the thread or notebook an item opens, and nothing else', () => {
    expect(paletteTarget('thread thr_1 Plan the launch')).toEqual({ kind: 'thread', id: 'thr_1' });
    expect(paletteTarget('notebook nb_2 Research')).toEqual({ kind: 'notebook', id: 'nb_2' });
    expect(paletteTarget('recent thread:thr_3 Old chat')).toEqual({ kind: 'thread', id: 'thr_3' });
    expect(paletteTarget('recent notebook:nb_4 Notes')).toEqual({ kind: 'notebook', id: 'nb_4' });
    expect(paletteTarget('recent command:go.admin Open admin')).toBeNull();
    expect(paletteTarget('command Open settings')).toBeNull();
    expect(paletteTarget('message msg_1 query title')).toBeNull();
    expect(paletteTarget('model gpt-5 openai')).toBeNull();
    expect(paletteTarget('')).toBeNull();
  });
});
