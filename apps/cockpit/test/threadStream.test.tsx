/**
 * ------------------------------------------------------------------
 *  Title    |  What a streamed token re-renders
 *  Ref      |  ROADMAP P2
 *  ID       |  cockpit/test
 * ------------------------------------------------------------------
 *  Purpose  |  A token arriving should redraw the message being
 *           |  written and nothing else: not the composer, not the
 *           |  messages above it, not the thread's own screen.
 *  How      |  The real ThreadView, with the composer and each message
 *           |  wrapped in a React Profiler that counts the commits
 *           |  which actually rendered them. Tokens go through the
 *           |  run store as the stream would send them.
 * ------------------------------------------------------------------
 */

import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ hash: '' }));
const counts = vi.hoisted(() => ({
  composer: 0,
  /** ThreadView's own renders (it asks for the current model on every one). */
  list: 0,
  rows: {} as Record<string, number>,
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...real,
    useParams: () => ({ threadId: 't1' }),
    useNavigate: () => vi.fn(),
    useRouterState: (o?: { select?: (s: unknown) => unknown }) =>
      o?.select ? o.select({ location: { hash: route.hash, pathname: '/t/t1' } }) : undefined,
    useSearch: () => ({}),
    Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
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
// Streams are not opened in jsdom; the tests push events through the run store.
vi.mock('../src/lib/sse', () => ({ openStream: () => () => {} }));
// A hook every render of the composer, and of a message, calls: counting its calls counts real
// renders, so memo at any level (the call site or the component) is measured, not assumed.
vi.mock('../src/thread/composerBar', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/thread/composerBar')>();
  return {
    ...real,
    useComposerBar: (...a: Parameters<typeof real.useComposerBar>) => {
      counts.composer++;
      return real.useComposerBar(...a);
    },
  };
});
vi.mock('../src/lib/models', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/models')>();
  return {
    ...real,
    useCurrentModel: (...a: Parameters<typeof real.useCurrentModel>) => {
      counts.list++;
      return real.useCurrentModel(...a);
    },
  };
});
vi.mock('../src/lib/factcheck', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/factcheck')>();
  return {
    ...real,
    useProgress: (id: string) => {
      counts.rows[id] = (counts.rows[id] ?? 0) + 1;
      return real.useProgress(id);
    },
  };
});

import type { RunEvent } from '@nvx/contracts';
import { api } from '../src/lib/api';
import { queryClient } from '../src/lib/query';
import { useRuns } from '../src/lib/run';
import { useUi } from '../src/state/ui';
import { ThreadView } from '../src/thread/ThreadView';

const get = vi.mocked(api.get);

const wireMessage = (i: number, role: 'user' | 'assistant', text: string, status = 'complete') => ({
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

/** n finished turns, then a question and the answer being written. */
function threadOf(turns: number) {
  const msgs = [];
  for (let t = 0; t < turns; t++) {
    msgs.push(wireMessage(t * 2, 'user', `Question ${t}`));
    msgs.push(wireMessage(t * 2 + 1, 'assistant', `Answer ${t}. Some words to read.`));
  }
  msgs.push(wireMessage(turns * 2, 'user', 'And now?'));
  msgs.push(wireMessage(turns * 2 + 1, 'assistant', '', 'streaming'));
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
    head_id: msgs.at(-1)?.id ?? null,
    messages: msgs,
    active_run: null,
    total: msgs.length,
    start: 0,
    has_more: false,
  };
}

const tokens = (n: number, id: string) =>
  Array.from(
    { length: n },
    (_, i) =>
      ({
        type: 'text.delta',
        seq: i + 1,
        at: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString(),
        message_id: id,
        delta: `word${i} `,
      }) as unknown as RunEvent,
  );

function mount(turns: number) {
  const path = threadOf(turns);
  get.mockImplementation(async (p: string) => {
    if (p.startsWith('/threads/t1/path')) return path;
    return { items: [], next_cursor: null };
  });
  const live = path.messages.at(-1)?.id ?? '';
  const r = render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>
        <ThreadView threadId="t1" />
      </Tooltip.Provider>
    </QueryClientProvider>,
  );
  return { ...r, live, last: path.messages.length - 1 };
}

beforeEach(() => {
  counts.composer = 0;
  counts.list = 0;
  counts.rows = {};
  route.hash = '';
  useUi.setState({ demo: false });
  get.mockReset();
});
afterEach(() => {
  queryClient.clear();
  useRuns.setState({ turns: {} });
});

describe('a streamed token', () => {
  it('redraws the message being written and not the composer or the messages above it', async () => {
    const { live } = mount(12);
    await screen.findByRole('list', { name: 'Conversation' });
    await act(async () => {});
    act(() => useRuns.getState().start({ runId: 'r1', threadId: 't1', messageId: live }));
    await act(async () => {});
    const before = { composer: counts.composer, screen: counts.list, rows: { ...counts.rows } };
    const N = 40;
    for (const e of tokens(N, live)) act(() => useRuns.getState().apply(live, e));
    const composer = counts.composer - before.composer;
    const screenRenders = counts.list - before.screen;
    const others = Object.entries(counts.rows)
      .filter(([id]) => id !== live)
      .reduce((n, [id, c]) => n + (c - (before.rows[id] ?? 0)), 0);
    const writing = (counts.rows[live] ?? 0) - (before.rows[live] ?? 0);
    console.log(
      `[perf] ${N} tokens: thread screen ${screenRenders} renders, composer ${composer}, other messages ${others}, message being written ${writing}`,
    );
    expect(writing).toBeGreaterThanOrEqual(1);
    expect(composer).toBe(0);
    expect(screenRenders).toBe(0);
    expect(others).toBe(0);
  });
});
