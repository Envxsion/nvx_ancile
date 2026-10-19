/**
 * ------------------------------------------------------------------
 *  Title    |  A long thread keeps only what is near drawn
 *  Ref      |  ROADMAP P3
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  Rows far from the screen go back to their words at the
 *           |  height they measured, and everything that has to keep
 *           |  working still does: a #message-id link lands on its
 *           |  message, the browser's find reaches text outside the
 *           |  drawn rows, the row you are typing in or tabbing through
 *           |  stays, and a streaming answer keeps the view at the end.
 *  How      |  A controllable IntersectionObserver reports which rows
 *           |  are near (the small margin) or far (the wide one).
 * ------------------------------------------------------------------
 */

import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ hash: '' }));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...real,
    useParams: () => ({ threadId: 't1' }),
    useNavigate: () => vi.fn(),
    useRouterState: (o?: { select?: (s: unknown) => unknown }) =>
      o?.select ? o.select({ location: { hash: route.hash, pathname: '/t/t1' } }) : undefined,
    useSearch: () => ({}),
    Link: ({ children, className }: { children: ReactNode; className?: string }) => (
      <a href="#link" className={className}>
        {children}
      </a>
    ),
  };
});
vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});
vi.mock('../src/lib/sse', () => ({ openStream: () => () => {} }));

import type { RunEvent } from '@nvx/contracts';
import { api } from '../src/lib/api';
import { toMessageViews } from '../src/lib/mappers';
import { queryClient } from '../src/lib/query';
import { useRuns } from '../src/lib/run';
import { useUi } from '../src/state/ui';
import { KEEP_MARGIN, LAZY_MARGIN, LazyRoot, LazyRow, placeholderText } from '../src/thread/LazyRow';
import { EAGER_TAIL, MessageList } from '../src/thread/MessageList';
import { ThreadView } from '../src/thread/ThreadView';

const get = vi.mocked(api.get);

/** An IntersectionObserver the test drives: report a row near, or far, by the margin it was made with. */
class FakeIo {
  static all: FakeIo[] = [];
  watched = new Set<Element>();
  constructor(
    private cb: IntersectionObserverCallback,
    readonly opts: IntersectionObserverInit,
  ) {
    FakeIo.all.push(this);
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
  report(el: Element, isIntersecting: boolean) {
    this.cb(
      [{ target: el, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  /** Say `el` is inside (true) or outside (false) the zone with this margin. */
  static zone(margin: string, el: Element, isIntersecting: boolean) {
    for (const io of FakeIo.all)
      if (io.opts.rootMargin === margin && io.watched.has(el)) io.report(el, isIntersecting);
  }
}

const wire = (i: number, role: 'user' | 'assistant', text: string, status = 'complete') => ({
  id: `m${i}`,
  thread_id: 't1',
  parent_id: i ? `m${i - 1}` : null,
  role,
  model_id: role === 'assistant' ? 'offline/echo' : null,
  requested_model_id: null,
  status,
  edit_of_id: null,
  provenance: {},
  usage: null,
  run_id: null,
  trace_id: '0'.repeat(32),
  created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  parts: text ? [{ type: 'text', text }] : [],
});

function messages(n: number, text = (i: number) => `Message number ${i} with some words.`) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(wire(i, i % 2 ? 'assistant' : 'user', text(i)));
  return toMessageViews(out as never);
}

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

function list(msgs: ReturnType<typeof messages>, extra: Partial<Parameters<typeof MessageList>[0]> = {}) {
  const scroller = createRef<HTMLDivElement>();
  return wrap(
    <div ref={scroller}>
      <MessageList
        messages={msgs}
        threadId="t1"
        selected={null}
        onSelect={() => {}}
        jumpTo={null}
        cwd={null}
        scroller={scroller}
        {...extra}
      />
    </div>,
  );
}

const rowOf = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLElement>(`li[data-mid="${id}"]`) as HTMLElement;
const drawn = (li: HTMLElement) => !!li.querySelector('.msg');
const words = (li: HTMLElement) => li.querySelector('[data-lazy]');

beforeEach(() => {
  FakeIo.all = [];
  vi.stubGlobal('IntersectionObserver', FakeIo);
  // jsdom lays nothing out: a row measures 321 px.
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 321 });
  Element.prototype.scrollIntoView = vi.fn();
  route.hash = '';
  useUi.setState({ demo: false });
  get.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
  queryClient.clear();
  useRuns.setState({ turns: {} });
});

describe('a row far from the screen', () => {
  it('draws when it comes near, and goes back to its words, at its height, when it is far', async () => {
    const { container } = list(messages(30));
    await act(async () => {});
    const li = rowOf(container, 'm3');
    expect(drawn(li)).toBe(false);
    expect(words(li)?.textContent).toContain('Message number 3');

    act(() => FakeIo.zone(LAZY_MARGIN, li, true));
    expect(drawn(li)).toBe(true);
    expect(words(li)).toBeNull();

    // Still inside the wide zone: stays drawn (no flapping at the edge).
    act(() => FakeIo.zone(KEEP_MARGIN, li, true));
    expect(drawn(li)).toBe(true);

    act(() => FakeIo.zone(KEEP_MARGIN, li, false));
    expect(drawn(li)).toBe(false);
    const held = words(li) as HTMLElement;
    expect(held.textContent).toContain('Message number 3');
    expect(held.style.height).toBe('321px');
    // Its words are what the browser's find sees, and it can be drawn again.
    act(() => FakeIo.zone(LAZY_MARGIN, li, true));
    expect(drawn(li)).toBe(true);
  });

  it('keeps the last few, a streaming answer, the selected row and the jumped-to row drawn', async () => {
    const msgs = messages(30);
    const { container } = list(msgs, { selected: 'm5', jumpTo: 'm8' });
    await act(async () => {});
    for (const id of ['m5', 'm8']) {
      const li = rowOf(container, id);
      act(() => FakeIo.zone(KEEP_MARGIN, li, false));
      expect(drawn(li), id).toBe(true);
    }
    const tail = msgs.slice(-EAGER_TAIL);
    for (const m of tail) expect(drawn(rowOf(container, m.id)), m.id).toBe(true);
    expect(drawn(rowOf(container, 'm10'))).toBe(false);
  });

  it('is not taken down while keyboard focus is inside it', async () => {
    const { container } = list(messages(30));
    await act(async () => {});
    const li = rowOf(container, 'm3');
    act(() => FakeIo.zone(LAZY_MARGIN, li, true));
    const target = li.querySelector<HTMLElement>('button, a, [tabindex]');
    expect(target, 'a drawn message has something to focus').not.toBeNull();
    (target as HTMLElement).focus();
    expect(li.contains(document.activeElement)).toBe(true);
    act(() => FakeIo.zone(KEEP_MARGIN, li, false));
    expect(drawn(li)).toBe(true);
    // Focus leaves: the next time it is far, it goes.
    (document.activeElement as HTMLElement).blur();
    act(() => FakeIo.zone(KEEP_MARGIN, li, false));
    expect(drawn(li)).toBe(false);
  });

  it('holds only a few dozen drawn after reading a thread from end to end', async () => {
    const msgs = messages(150);
    const { container } = list(msgs);
    await act(async () => {});
    // Read down: each row comes near, then the ones 5,000 px behind go far.
    const ids = msgs.map((m) => m.id);
    let peak = 0;
    ids.forEach((id, i) => {
      const li = rowOf(container, id);
      act(() => FakeIo.zone(LAZY_MARGIN, li, true));
      const behind = ids[i - 25];
      if (behind) act(() => FakeIo.zone(KEEP_MARGIN, rowOf(container, behind), false));
      peak = Math.max(peak, container.querySelectorAll('li .msg').length);
    });
    expect(peak).toBeLessThanOrEqual(25 + EAGER_TAIL + 2);
    expect(container.querySelectorAll('li .msg').length).toBeLessThan(40);
  });
});

describe('find in the thread', () => {
  it('reaches text in rows that are not drawn, deep into a long message', async () => {
    const long = (i: number) => `${'Plain opening words. '.repeat(300)} needle-${i} closing words.`;
    const msgs = messages(20, long);
    const { container } = list(msgs);
    await act(async () => {});
    const li = rowOf(container, 'm2');
    expect(drawn(li)).toBe(false);
    // The needle sits well past 5,000 characters, as the browser's own find would need it.
    expect(placeholderText(msgs[2] as never)).toContain('needle-2');
    expect(words(li)?.textContent).toContain('needle-2');
  });
});

describe('a link to a message', () => {
  const thread = (n: number) => {
    const m = [];
    for (let i = 0; i < n; i++) m.push(wire(i, i % 2 ? 'assistant' : 'user', `Message number ${i}.`));
    return {
      thread: {
        id: 't1',
        title: 'T',
        notebook_id: null,
        active_head_id: null,
        settings: {},
        pinned_at: null,
        archived_at: null,
        created_at: '',
        updated_at: '',
      },
      head_id: `m${n - 1}`,
      messages: m,
      active_run: null,
      total: n,
      start: 0,
      has_more: false,
    };
  };
  const mountThread = (n: number) => {
    const path = thread(n);
    get.mockImplementation(async (p: string) =>
      p.startsWith('/threads/t1/path') ? path : { items: [], next_cursor: null },
    );
    return wrap(<ThreadView threadId="t1" />);
  };

  it('draws the message the #hash names, even far from the end, and scrolls to it', async () => {
    route.hash = '#m4';
    const { container } = mountThread(60);
    await screen.findByRole('list', { name: 'Conversation' });
    const li = rowOf(container, 'm4');
    await waitFor(() => expect(drawn(li)).toBe(true));
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    const scrolled = vi.mocked(Element.prototype.scrollIntoView).mock.contexts as unknown as HTMLElement[];
    expect(scrolled.some((el) => el === li)).toBe(true);
    // The rows around it are only their words.
    expect(drawn(rowOf(container, 'm20'))).toBe(false);
  });
});

describe('following a streaming answer', () => {
  it('keeps the view at the end while you are at the end, and lets go once you scroll up', async () => {
    const path = {
      thread: {
        id: 't1',
        title: 'T',
        notebook_id: null,
        active_head_id: null,
        settings: {},
        pinned_at: null,
        archived_at: null,
        created_at: '',
        updated_at: '',
      },
      head_id: 'm3',
      messages: [
        wire(0, 'user', 'Q'),
        wire(1, 'assistant', 'A'),
        wire(2, 'user', 'And?'),
        wire(3, 'assistant', '', 'streaming'),
      ],
      active_run: null,
      total: 4,
      start: 0,
      has_more: false,
    };
    get.mockImplementation(async (p: string) =>
      p.startsWith('/threads/t1/path') ? path : { items: [], next_cursor: null },
    );
    const { container } = wrap(<ThreadView threadId="t1" />);
    await screen.findByRole('list', { name: 'Conversation' });
    const scroller = container.querySelector('.thread__scroll') as HTMLElement;
    let top = 0;
    let height = 2000;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v) => {
        top = v;
      },
    });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 600 });

    act(() => useRuns.getState().start({ runId: 'r1', threadId: 't1', messageId: 'm3' }));
    const send = (n: number, from: number) => {
      for (let i = 0; i < n; i++)
        act(() =>
          useRuns.getState().apply('m3', {
            type: 'text.delta',
            seq: from + i,
            at: new Date(Date.UTC(2026, 0, 2, 0, 0, from + i)).toISOString(),
            message_id: 'm3',
            delta: `word${from + i} `,
          } as unknown as RunEvent),
        );
    };
    height = 2400;
    send(5, 1);
    expect(top).toBe(2400);

    // You scroll up to read: the view stops following.
    top = 300;
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll'));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    height = 3000;
    send(5, 10);
    expect(top).toBe(300);
  });
});

describe('LazyRow without a root', () => {
  it('draws in full when there is no IntersectionObserver at all', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const [m] = messages(1);
    const scroller = createRef<HTMLDivElement>();
    const { container } = render(
      <div ref={scroller}>
        <LazyRoot scroller={scroller}>
          <ol>
            <LazyRow m={m as never} eager={false}>
              {() => <p data-testid="full">full</p>}
            </LazyRow>
          </ol>
        </LazyRoot>
      </div>,
    );
    expect(container.querySelector('[data-testid="full"]')).not.toBeNull();
  });
});
