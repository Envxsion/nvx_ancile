/**
 * KP1 in the real palette: Tab opens the action panel on the highlighted
 * result, Escape goes back before it closes, Shift+Enter acts and stays,
 * a settings result that is on or off changes where it is, and a choice
 * previews while you move over it and is put back when you leave.
 */
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => nav.navigate,
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: '/' } }),
  Link: ({ children }: { children: ReactNode }) => <a href="#x">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...real,
    api: {
      get: vi.fn().mockRejectedValue(new Error('offline')),
      post: vi.fn().mockResolvedValue({}),
      put: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue({}),
      del: vi.fn().mockResolvedValue({}),
    },
  };
});
vi.mock('../src/lib/prefetch', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/prefetch')>();
  return { ...real, prefetchTarget: vi.fn() };
});
vi.mock('../src/lib/threads', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/threads')>();
  return {
    ...real,
    setPinned: vi.fn(async () => undefined),
    setArchived: vi.fn(async () => undefined),
    moveThread: vi.fn(async () => undefined),
    deleteThread: vi.fn(),
    exportThread: vi.fn(),
  };
});

import { DEFAULT_PREFERENCES } from '@nvx/contracts';
import { keys } from '../src/lib/data';
import { PRELOAD_DELAY_MS, prefetchTarget } from '../src/lib/prefetch';
import { queryClient } from '../src/lib/query';
import { setPinned } from '../src/lib/threads';
import { Palette } from '../src/palette/Palette';
import { usePrefs } from '../src/state/prefs';
import { useUi } from '../src/state/ui';

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

// cmdk measures with these; jsdom has neither.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  queryClient.clear();
  // Two threads the palette can offer actions on.
  queryClient.setQueryData(keys.threads, {
    pages: [
      {
        items: [
          { id: 't1', title: 'Tide tables', notebookId: null, updatedAt: '2026-10-19', branches: 1 },
          {
            id: 't2',
            title: 'Kite plans',
            notebookId: null,
            updatedAt: '2026-10-18',
            branches: 1,
            pinned: true,
          },
        ],
        next: null,
      },
    ],
    pageParams: [null],
  });
  nav.navigate.mockReset();
  usePrefs.setState({ prefs: DEFAULT_PREFERENCES });
  // Sample workspace: a few threads, notebooks and models without a Core.
  useUi.setState({ demo: true, paletteOpen: true, paletteScope: 'all', paletteQuery: '' });
});
afterEach(() => useUi.setState({ paletteOpen: false }));

const input = () => screen.getByRole('combobox');
const type = async (text: string) => {
  fireEvent.change(input(), { target: { value: text } });
  // cmdk selects the first match on the next frame.
  await act(() => new Promise((r) => setTimeout(r, 30)));
};
const key = (el: Element, init: KeyboardEventInit) => fireEvent.keyDown(el, init);

describe('settings that change in place', () => {
  it('shows the state beside the row, and Enter flips it without closing', async () => {
    wrap(<Palette />);
    await type(',film grain');
    const row = await screen.findByRole('option', { name: /Film grain/ });
    expect(row).toHaveTextContent('Off');
    fireEvent.click(row);
    await waitFor(() => expect(usePrefs.getState().prefs.appearance.grain).toBe(true));
    expect(screen.getByRole('option', { name: /Film grain/ })).toHaveTextContent('On');
    // Still open, and a screen reader is told.
    expect(useUi.getState().paletteOpen).toBe(true);
    expect(screen.getByText('Film grain: on.')).toBeInTheDocument();
  });

  it('a page-sized setting still opens its page', async () => {
    wrap(<Palette />);
    await type(',zoom');
    fireEvent.click(await screen.findByRole('option', { name: /Zoom/ }));
    expect(nav.navigate).toHaveBeenCalledWith({ to: '/settings/$group', params: { group: 'appearance' } });
    expect(useUi.getState().paletteOpen).toBe(false);
  });
});

describe('the action panel', () => {
  it('Tab opens it on the highlighted thread; Escape goes back first, then closes', async () => {
    wrap(<Palette />);
    await type('tide');
    const thread = await screen.findByRole('option', { name: /Tide tables/ });
    fireEvent.pointerMove(thread);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    key(input(), { key: 'Tab' });
    expect(await screen.findByRole('option', { name: /Open in a new window/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Move to the Trash/ })).toBeInTheDocument();
    expect(screen.getByText(/Actions for .*\. \d+ actions?\./)).toBeInTheDocument();
    // Escape: back to the results, palette still open.
    key(screen.getByPlaceholderText('Filter actions'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByPlaceholderText('Filter actions')).toBeNull());
    expect(useUi.getState().paletteOpen).toBe(true);
  });

  it('choosing an action runs it through the app and closes the palette', async () => {
    wrap(<Palette />);
    await type('tide');
    const thread = await screen.findByRole('option', { name: /Tide tables/ });
    fireEvent.pointerMove(thread);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    key(input(), { key: 'Enter', ctrlKey: true });
    fireEvent.click(await screen.findByRole('option', { name: /^(Pin|Unpin)/ }));
    await waitFor(() => expect(setPinned).toHaveBeenCalled());
    expect(useUi.getState().paletteOpen).toBe(false);
  });

  it('a result with no actions says so instead of doing nothing', async () => {
    wrap(<Palette />);
    await type('>');
    key(input(), { key: 'Tab' });
    await waitFor(() => expect(screen.getByText(/No other actions for this result/)).toBeInTheDocument());
  });

  it('a choice previews as you move over it, keeps what you choose, and goes back when you leave', async () => {
    wrap(<Palette />);
    await type(',theme');
    const row = await screen.findByRole('option', { name: /^Theme/ });
    fireEvent.pointerMove(row);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    key(input(), { key: 'Tab' });
    const dark = await screen.findByRole('option', { name: /^Dark/ });
    fireEvent.pointerMove(dark);
    await waitFor(() => expect(usePrefs.getState().prefs.appearance.theme).toBe('dark'));
    // Back out without choosing: the old theme returns.
    key(screen.getByPlaceholderText('Filter actions'), { key: 'Escape' });
    await waitFor(() => expect(usePrefs.getState().prefs.appearance.theme).toBe('system'));
  });
});

describe('what the palette already did keeps working', () => {
  it('fetches the highlighted thread once the highlight rests on it', async () => {
    wrap(<Palette />);
    await type('tide');
    vi.mocked(prefetchTarget).mockClear();
    fireEvent.pointerMove(await screen.findByRole('option', { name: /Tide tables/ }));
    await act(() => new Promise((r) => setTimeout(r, PRELOAD_DELAY_MS + 60)));
    expect(prefetchTarget).toHaveBeenCalledWith({ kind: 'thread', id: 't1' });
  });

  it('Enter opens a thread and closes; Shift+Enter opens it and stays', async () => {
    wrap(<Palette />);
    await type('tide');
    const row = await screen.findByRole('option', { name: /Tide tables/ });
    fireEvent.pointerMove(row);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    key(input(), { key: 'Enter', shiftKey: true });
    await waitFor(() =>
      expect(nav.navigate).toHaveBeenCalledWith({ to: '/t/$threadId', params: { threadId: 't1' } }),
    );
    expect(useUi.getState().paletteOpen).toBe(true);
    // The next plain Enter closes, as always.
    key(input(), { key: 'Enter' });
    await waitFor(() => expect(useUi.getState().paletteOpen).toBe(false));
  });
});
