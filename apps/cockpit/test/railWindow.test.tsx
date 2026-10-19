/**
 * ------------------------------------------------------------------
 *  Title    |  A long rail draws only what is near
 *  Ref      |  ROADMAP P7
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  With a thousand threads the rail draws a window of them
 *           |  and keeps everything else it promises: headings,
 *           |  pinned rows and notebook rows are always there, the
 *           |  keyboard cursor can land on a row that would be hidden,
 *           |  a row holding focus is not taken from under it, a short
 *           |  list is drawn whole, and filtering shrinks the list
 *           |  back to a plain one.
 * ------------------------------------------------------------------
 */

import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const params = vi.hoisted(() => ({}) as Record<string, string | undefined>);

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...real,
    useParams: () => params,
    useNavigate: () => vi.fn(),
    useRouterState: () => '/',
    useSearch: () => ({}),
    Link: ({
      children,
      to,
      params: p,
      className,
      title,
    }: {
      children: ReactNode;
      to: string;
      params?: Record<string, string>;
      className?: string;
      title?: string;
    }) => (
      <a href={p ? to.replace(/\$\w+/, Object.values(p)[0] ?? '') : to} className={className} title={title}>
        {children}
      </a>
    ),
  };
});
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { RAIL_WINDOW_AT, Rail, WINDOW_LIST_MIN } from '../src/shell/Rail';
import { segmentsFor, WindowedList, windowFor } from '../src/shell/WindowedList';
import { useUi } from '../src/state/ui';

const get = vi.mocked(api.get);

const HOUR = 3_600_000;
function thread(i: number, extra: Record<string, unknown> = {}) {
  return {
    id: `thr_${i}`,
    title: `Thread ${i}`,
    notebook_id: null,
    active_head_id: null,
    settings: {},
    pinned_at: null,
    archived_at: null,
    created_at: '',
    updated_at: new Date(Date.now() - i * HOUR * 4).toISOString(),
    branches: 1,
    live: false,
    ...extra,
  };
}
const notebook = (i: number) => ({
  id: `nb_${i}`,
  title: `Notebook ${i}`,
  description: '',
  icon: null,
  color: null,
  pinned: false,
  archived_at: null,
  grounded: false,
  counts: { sources: 2, threads: 3 },
  created_at: '',
  updated_at: '',
});

function workspace(n: number) {
  const items = Array.from({ length: n }, (_, i) =>
    thread(i, i < 3 ? { pinned_at: '2026-01-01T00:00:00Z' } : i % 50 === 7 ? { notebook_id: 'nb_1' } : {}),
  );
  get.mockImplementation(async (path: string) => {
    if (path.startsWith('/threads?')) return { items, next_cursor: null };
    if (path === '/notebooks') return { items: [notebook(1), notebook(2)], next_cursor: null };
    return { items: [], next_cursor: null };
  });
}

function mountRail() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <Rail />
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
}

/** The rail's scroller, 600 px tall, scrolled to `top`. */
function scrollTo(container: HTMLElement, top: number) {
  const sc = container.querySelector('.rail__scroll') as HTMLElement;
  Object.defineProperty(sc, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(sc, 'scrollTop', { configurable: true, get: () => top, set: () => {} });
  act(() => {
    sc.dispatchEvent(new Event('scroll'));
  });
}
const flush = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

beforeEach(() => {
  for (const k of Object.keys(params)) delete params[k];
  useUi.setState({ demo: false, railOpen: true });
  get.mockReset();
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
});
afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

describe('the arithmetic', () => {
  it('draws the rows in view plus a screen either side, clamped to the list', () => {
    // 31 px rows, a list starting 100 px down, a 620 px view scrolled to 3,100 px.
    expect(windowFor(1000, 3100, 620, 100, 31, 10)).toEqual({ from: 86, to: 127 });
    expect(windowFor(1000, 0, 620, 100, 31, 10)).toEqual({ from: 0, to: 27 });
    expect(windowFor(50, 90_000, 620, 100, 31, 10)).toEqual({ from: 50, to: 50 });
  });

  it('merges the window with extra rows that must stay drawn', () => {
    expect(segmentsFor(1000, 10, 20, [])).toEqual([{ from: 10, to: 20 }]);
    expect(segmentsFor(1000, 10, 20, [20, 21])).toEqual([{ from: 10, to: 22 }]);
    expect(segmentsFor(1000, 10, 20, [500, 5])).toEqual([
      { from: 5, to: 6 },
      { from: 10, to: 20 },
      { from: 500, to: 501 },
    ]);
    expect(segmentsFor(1000, 10, 20, [-1, 1000])).toEqual([{ from: 10, to: 20 }]);
    expect(segmentsFor(0, 0, 0, [])).toEqual([]);
  });
});

describe('WindowedList', () => {
  const items = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}` }));
  function setup(props: { cursorKey?: string | null; from?: number; items?: typeof items } = {}) {
    const scroller = createRef<HTMLDivElement>();
    const ui = (p: typeof props) => (
      <div ref={scroller} style={{ height: 600 }}>
        <WindowedList
          items={p.items ?? items}
          keyOf={(i) => i.id}
          scroller={scroller}
          from={p.from ?? 60}
          cursorKey={p.cursorKey ?? null}
        >
          {(i) => (
            <a href={`#${i.id}`} data-row={i.id}>
              {i.id}
            </a>
          )}
        </WindowedList>
      </div>
    );
    // jsdom does not scroll or lay out: keep the position the test sets, and put the list at the
    // top of the scroller's content, so its box moves up as the scroller goes down.
    let top = 0;
    vi.spyOn(HTMLUListElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ top: -top, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: -top }) as DOMRect,
    );
    const r = render(ui(props));
    const sc = scroller.current as HTMLDivElement;
    Object.defineProperty(sc, 'clientHeight', { configurable: true, get: () => 620 });
    Object.defineProperty(sc, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v) => {
        top = v;
      },
    });
    return { ...r, sc, again: (p: typeof props) => r.rerender(ui(p)) };
  }
  const rows = (c: HTMLElement) =>
    [...c.querySelectorAll<HTMLElement>('[data-row]')].map((n) => n.dataset.row);

  it('draws a short list whole, as a plain list', () => {
    const { container } = setup({ items: items.slice(0, 30) });
    expect(rows(container)).toHaveLength(30);
    expect(container.querySelector('[data-windowed]')).toBeNull();
    expect(container.querySelectorAll('li[aria-hidden]')).toHaveLength(0);
  });

  it('draws a window, stands in for the rest with space of the right height, and follows the scroll', async () => {
    const { container, sc } = setup();
    await flush();
    const first = rows(container);
    expect(first.length).toBeLessThan(60);
    expect(first[0]).toBe('r0');
    const space = [...container.querySelectorAll<HTMLElement>('li[data-gap]')];
    // Everything not drawn is a spacer: drawn rows + spacer rows add up to all 500 at 31 px.
    const spacerPx = space.reduce((n, s) => n + Number.parseFloat(s.style.height), 0);
    expect(Math.round((spacerPx + first.length * 31) / 31)).toBeGreaterThanOrEqual(499);

    sc.scrollTop = 31 * 300;
    act(() => {
      sc.dispatchEvent(new Event('scroll'));
    });
    await flush();
    const moved = rows(container);
    expect(moved).toContain('r310');
    expect(moved).not.toContain('r0');
    expect(moved.length).toBeLessThan(60);
  });

  it('tells screen readers where each drawn row sits in the whole list', async () => {
    const { container } = setup();
    await flush();
    const li = container.querySelector('li[data-i="3"]') as HTMLElement;
    expect(li).toHaveAttribute('aria-posinset', '4');
    expect(li).toHaveAttribute('aria-setsize', '500');
    for (const gap of container.querySelectorAll('li[data-gap]'))
      expect(gap).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws the keyboard cursor’s row wherever it is, in its place', async () => {
    const { container, again } = setup();
    await flush();
    expect(rows(container)).not.toContain('r400');
    again({ cursorKey: 'r400' });
    await flush();
    const row = container.querySelector('[data-row="r400"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect((row.closest('li') as HTMLElement).dataset.i).toBe('400');
    // The rows around the cursor are still space, so the scroll height has not changed.
    expect(rows(container)).not.toContain('r399');
    again({ cursorKey: 'r401' });
    await flush();
    expect(rows(container)).toContain('r401');
    expect(rows(container)).not.toContain('r400');
  });

  it('does not take a row from under keyboard focus', async () => {
    const { container, sc } = setup();
    await flush();
    const link = container.querySelector('[data-row="r4"]') as HTMLElement;
    link.focus();
    fireEvent.focusIn(link);
    await flush();
    sc.scrollTop = 31 * 300;
    act(() => {
      sc.dispatchEvent(new Event('scroll'));
    });
    await flush();
    expect(rows(container)).toContain('r4');
    expect(document.activeElement).toBe(link);
    link.blur();
    fireEvent.focusOut(link);
    await flush();
    expect(rows(container)).not.toContain('r4');
  });
});

describe('the rail with a thousand threads', () => {
  it('draws a window of the threads and all of its headings, pinned rows and notebooks', async () => {
    workspace(1000);
    const { container } = mountRail();
    await screen.findByText('Notebook 1');
    await flush();
    const nav = within(container.querySelector('.rail__scroll') as HTMLElement);
    // Headings, pinned, notebooks.
    expect(nav.getByRole('button', { name: 'Pinned' })).toBeInTheDocument();
    expect(nav.getByRole('button', { name: 'Notebooks' })).toBeInTheDocument();
    expect(nav.getByRole('button', { name: 'Today' })).toBeInTheDocument();
    for (const t of ['Thread 0', 'Thread 1', 'Thread 2']) expect(nav.getByText(t)).toBeInTheDocument();
    expect(nav.getByText('Notebook 2')).toBeInTheDocument();
    // A window of a few dozen, not a thousand.
    const links = container.querySelectorAll('.rail__scroll a.rail__item').length;
    expect(links).toBeLessThan(150);
    expect(container.querySelectorAll('.rail__scroll [data-windowed]').length).toBeGreaterThan(0);
    console.log(
      `[perf] rail, 1000 threads: ${links} links and ${container.querySelectorAll('.rail__scroll *').length} nodes drawn`,
    );
    expect(RAIL_WINDOW_AT).toBe(300);
    expect(WINDOW_LIST_MIN).toBeGreaterThan(10);
  });

  it('draws a small rail whole', async () => {
    workspace(40);
    const { container } = mountRail();
    await screen.findByText('Thread 39');
    expect(container.querySelector('[data-windowed]')).toBeNull();
    expect(container.querySelectorAll('.rail__scroll a.rail__item').length).toBeGreaterThanOrEqual(40);
  });

  it('filtering finds a thread that is far down, and a short result is a plain list', async () => {
    workspace(1000);
    const { container } = mountRail();
    await screen.findByText('Notebook 1');
    await flush();
    expect(screen.queryByText('Thread 990')).toBeNull();
    fireEvent.change(screen.getByLabelText('Filter notebooks and threads'), {
      target: { value: 'Thread 990' },
    });
    expect(await screen.findByText('Thread 990')).toBeInTheDocument();
    expect(container.querySelector('[data-windowed]')).toBeNull();
    scrollTo(container, 0);
  });
});
