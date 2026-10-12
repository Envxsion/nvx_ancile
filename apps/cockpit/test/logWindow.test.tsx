/**
 * The log viewer at 50,000 lines: LogWindow draws only the blocks near the
 * viewport (the newest always), keeps block keys stable as lines arrive at
 * the top, empties a block that moves away at its measured height, and the
 * Logs screen pages back with "Load older lines".
 */
import type { LogLine, LogPage } from '@nvx/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="#link">{children}</a>,
}));
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
vi.mock('../src/lib/sse', () => ({ openStream: vi.fn(() => () => undefined) }));

import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { LogsScreen } from '../src/ops/LogsScreen';
import { blocksOf, LOG_BLOCK, LOG_ROW_ESTIMATE, LogWindow } from '../src/ops/LogWindow';

const get = (api as unknown as { get: ReturnType<typeof vi.fn> }).get;

/** An IntersectionObserver the test drives: `fire(el, true)` says el came near. */
class DrivenObserver {
  static all: DrivenObserver[] = [];
  readonly watched = new Set<Element>();
  constructor(private readonly cb: IntersectionObserverCallback) {
    DrivenObserver.all.push(this);
  }
  observe(el: Element) {
    this.watched.add(el);
  }
  unobserve(el: Element) {
    this.watched.delete(el);
  }
  disconnect() {
    this.watched.clear();
  }
  takeRecords() {
    return [];
  }
  fire(el: Element, near: boolean, height = 0) {
    this.cb(
      [
        {
          target: el,
          isIntersecting: near,
          boundingClientRect: { height } as DOMRectReadOnly,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
}
const observer = () => DrivenObserver.all.at(-1) as DrivenObserver;

const line = (id: number): LogLine =>
  ({
    id,
    at: new Date(Date.UTC(2026, 9, 12, 0, 0, id % 60)).toISOString(),
    level: id % 50 === 0 ? 'warn' : 'info',
    service: 'core',
    component: 'http',
    trace_id: null,
    span_id: null,
    msg: `line ${id}`,
    data: {},
  }) as LogLine;

/** Newest first, as the screen holds them. */
const lines = (n: number, top = n) => Array.from({ length: n }, (_, i) => line(top - i));

beforeEach(() => {
  DrivenObserver.all = [];
  vi.stubGlobal('IntersectionObserver', DrivenObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('blocksOf', () => {
  it('counts blocks from the oldest, so new lines only change the first', () => {
    const before = blocksOf(lines(250));
    expect(before.map((b) => [b.key, b.items.length])).toEqual([
      [2, 50],
      [1, 100],
      [0, 100],
    ]);
    const after = blocksOf(lines(251, 251));
    expect(after.map((b) => [b.key, b.items.length])).toEqual([
      [2, 51],
      [1, 100],
      [0, 100],
    ]);
    // The older blocks hold the very same lines.
    expect(after[2]?.items.map((l) => l.id)).toEqual(before[2]?.items.map((l) => l.id));
    expect(blocksOf([])).toEqual([]);
  });
});

describe('LogWindow at 50,000 lines', () => {
  const N = 50_000;

  function mount(items: LogLine[]) {
    const scroller = createRef<HTMLDivElement>();
    const ui = (xs: LogLine[]) => (
      <div ref={scroller}>
        <LogWindow
          items={xs}
          scroller={scroller}
          keyOf={(l) => l.id}
          render={(l) => <div className="logline">{l.msg}</div>}
        />
      </div>
    );
    const r = render(ui(items));
    return { ...r, rerender: (xs: LogLine[]) => r.rerender(ui(xs)) };
  }
  const rows = () => document.querySelectorAll('.logline').length;
  const blockEls = () => [...document.querySelectorAll<HTMLElement>('.logblock')];

  it('draws only the newest block, with every other block an empty box of the right height', () => {
    const started = performance.now();
    mount(lines(N));
    const took = performance.now() - started;
    expect(rows()).toBe(LOG_BLOCK);
    expect(blockEls()).toHaveLength(N / LOG_BLOCK);
    const idle = blockEls().filter((b) => b.hasAttribute('data-idle'));
    expect(idle).toHaveLength(N / LOG_BLOCK - 1);
    expect(idle[0]?.style.height).toBe(`${LOG_BLOCK * LOG_ROW_ESTIMATE}px`);
    expect(idle[0]).toHaveAttribute('aria-hidden', 'true');
    // Every block is watched, including the ones attached before the observer existed.
    expect(observer().watched.size).toBe(N / LOG_BLOCK);
    // Generous: drawing 50,000 lines in full took several seconds here.
    expect(took).toBeLessThan(3_000);
  });

  it('draws a block when it comes near and empties it at its measured height when it leaves', () => {
    mount(lines(N));
    const far = blockEls()[250] as HTMLElement;
    act(() => observer().fire(far, true));
    expect(far.hasAttribute('data-idle')).toBe(false);
    expect(far.querySelectorAll('.logline')).toHaveLength(LOG_BLOCK);
    expect(rows()).toBe(2 * LOG_BLOCK);
    act(() => observer().fire(far, false, 3_456));
    expect(far.hasAttribute('data-idle')).toBe(true);
    expect(far.style.height).toBe('3456px');
    expect(rows()).toBe(LOG_BLOCK);
  });

  it('keeps drawn blocks drawn while new lines arrive at the top', () => {
    const { rerender } = mount(lines(N));
    const mid = blockEls()[10] as HTMLElement;
    act(() => observer().fire(mid, true));
    const firstLine = mid.querySelector('.logline')?.textContent;
    rerender(lines(N + 7, N + 7));
    // Same element, same lines, still drawn; the 7 new lines started a new newest block above it.
    expect(blockEls()[11]).toBe(mid);
    expect(mid.querySelector('.logline')?.textContent).toBe(firstLine);
    expect(blockEls()[0]?.querySelectorAll('.logline')).toHaveLength(7);
  });

  it('draws everything without IntersectionObserver, as before', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    mount(lines(250));
    expect(rows()).toBe(250);
  });
});

describe('the Logs screen', () => {
  const page = (items: LogLine[], next: string | null): LogPage => ({
    items,
    next_cursor: next,
    facets: { services: ['core'], components: ['http'] },
  });

  it('pages back with Load older lines and still draws only what is near', async () => {
    queryClient.clear();
    get.mockReset();
    get.mockImplementation((path: string) => {
      const before = /before=(\d+)/.exec(path)?.[1];
      if (!before) return Promise.resolve(page(lines(300, 50_000), '49701'));
      const top = Number(before) - 1;
      return Promise.resolve(page(lines(1_000, top), String(top - 999)));
    });
    render(
      <QueryClientProvider client={queryClient}>
        <LogsScreen />
      </QueryClientProvider>,
    );
    const more = await screen.findByRole('button', { name: 'Load older lines' });
    expect(screen.getByText('300 lines')).toBeInTheDocument();
    fireEvent.click(more);
    await waitFor(() => expect(screen.getByText('1,300 lines')).toBeInTheDocument());
    expect(get).toHaveBeenLastCalledWith(expect.stringMatching(/limit=1000&before=49701$/));
    // 1,300 lines held, one block of them drawn.
    expect(document.querySelectorAll('.logline').length).toBeLessThanOrEqual(LOG_BLOCK);
    expect(screen.getByRole('log')).toBeInTheDocument();
  });
});
