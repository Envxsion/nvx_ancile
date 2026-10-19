/**
 * Long threads: paging merges (lib/threadPages.ts), what the cache writes to
 * IndexedDB (lib/query.ts), and the conversation list drawing only a window
 * (thread/MessageList.tsx), measured on a 5,000-message fixture.
 */
import type { Message, Part } from '@nvx/contracts';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClientProvider } from '@tanstack/react-query';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { act, render } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() } };
});

import { toMessageViews } from '../src/lib/mappers';
import {
  PERSIST_THREAD_TAIL,
  PERSIST_THREADS,
  persistable,
  queryClient,
  trimForPersist,
} from '../src/lib/query';
import { mergeTail, prependPage, readingAnchor, scrollTopFor } from '../src/lib/threadPages';
import type { MessageView, ThreadView } from '../src/lib/types';
import { EAGER_TAIL, MessageList } from '../src/thread/MessageList';

const view = (ids: string[], extra: Partial<ThreadView> = {}): ThreadView => ({
  id: 't1',
  title: 'T',
  notebookId: null,
  messages: ids.map((id) => ({ id, parentId: null, role: 'user', modelId: null, createdAt: '', blocks: [] })),
  cursor: ids[0] ?? null,
  hasMore: true,
  ...extra,
});
const idsOf = (t: ThreadView) => t.messages.map((m) => m.id);

describe('paging merges', () => {
  it('a fresh last page keeps what was loaded above it on the same path', () => {
    const prev = view(['a', 'b', 'c', 'd', 'e'], { cursor: 'a', hasMore: false });
    const next = view(['c', 'd', 'e', 'f'], { cursor: 'c', hasMore: true });
    const merged = mergeTail(prev, next);
    expect(idsOf(merged)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(merged).toMatchObject({ cursor: 'a', hasMore: false });
  });

  it('another branch (the page starts somewhere not loaded) replaces the window', () => {
    const prev = view(['a', 'b', 'c']);
    const next = view(['x', 'y'], { cursor: 'x' });
    expect(idsOf(mergeTail(prev, next))).toEqual(['x', 'y']);
    expect(idsOf(mergeTail(undefined, next))).toEqual(['x', 'y']);
  });

  it('an earlier page goes in front, in order, without repeats', () => {
    const cur = view(['d', 'e', 'f'], { cursor: 'd' });
    const out = prependPage(cur, view(['a', 'b', 'c', 'd'], { cursor: 'a', hasMore: false }));
    expect(idsOf(out)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(out).toMatchObject({ cursor: 'a', hasMore: false });
  });

  it('prepending keeps the message you were reading where it was', () => {
    // Rows of 100 px; reading m3, 30 px of it above the view.
    const rows = (ids: string[]) => ids.map((id, i) => ({ id, top: i * 100, height: 100 }));
    const before = rows(['m0', 'm1', 'm2', 'm3', 'm4']);
    const at = readingAnchor(before.length, (i) => before[i] as (typeof before)[number], 330);
    expect(at).toEqual({ id: 'm3', offset: -30 });
    // Sixty earlier messages land in front.
    const after = rows([...Array.from({ length: 60 }, (_, i) => `e${i}`), 'm0', 'm1', 'm2', 'm3', 'm4']);
    const top = scrollTopFor(
      at as NonNullable<typeof at>,
      (id) => after.find((r) => r.id === id)?.top ?? null,
    );
    expect(top).toBe(6330);
    expect(readingAnchor(0, () => ({ id: '', top: 0, height: 0 }), 0)).toBeNull();
  });
});

describe('what is written to IndexedDB', () => {
  const q = (key: unknown[], data: unknown, at = 1) =>
    ({
      queryKey: key,
      queryHash: JSON.stringify(key),
      state: { data, dataUpdatedAt: at, status: 'success' },
    }) as unknown as PersistedClient['clientState']['queries'][number];
  const client = (queries: PersistedClient['clientState']['queries']): PersistedClient => ({
    buster: 'x',
    timestamp: 0,
    clientState: { mutations: [], queries },
  });

  it('leaves out large and live queries', () => {
    expect(persistable(['threads'], 'success')).toBe(true);
    expect(persistable(['thread', 't1'], 'success')).toBe(true);
    for (const k of ['tree', 'budget', 'sources', 'source-content', 'claude-code'])
      expect(persistable([k, 'x'], 'success')).toBe(false);
    expect(persistable(['threads'], 'error')).toBe(false);
  });

  it('keeps the newest threads, cut to their last messages, and drops anything oversized', () => {
    const big = view(Array.from({ length: 500 }, (_, i) => `m${i}`));
    const threads = Array.from({ length: PERSIST_THREADS + 3 }, (_, i) => q(['thread', `t${i}`], big, i));
    const out = trimForPersist(
      client([
        ...threads,
        q(['threads'], { pages: [] }),
        q(['source-content', 's1'], { text: 'x' }),
        q(['models'], { huge: 'x'.repeat(400_000) }),
      ]),
    );
    const kept = out.clientState.queries;
    const keptThreads = kept.filter((k) => k.queryKey[0] === 'thread');
    expect(keptThreads).toHaveLength(PERSIST_THREADS);
    expect(keptThreads.map((k) => k.queryKey[1])).not.toContain('t0');
    const data = keptThreads[0]?.state.data as ThreadView;
    expect(data.messages).toHaveLength(PERSIST_THREAD_TAIL);
    expect(data.messages[0]?.id).toBe(`m${500 - PERSIST_THREAD_TAIL}`);
    expect(data).toMatchObject({ cursor: `m${500 - PERSIST_THREAD_TAIL}`, hasMore: true });
    expect(kept.map((k) => k.queryKey[0])).toContain('threads');
    expect(kept.map((k) => k.queryKey[0])).not.toContain('source-content');
    expect(kept.map((k) => k.queryKey[0])).not.toContain('models');
  });
});

/* ---- The 5,000-message fixture ------------------------------------------- */

const LONG_MD = [
  '## What changed',
  '',
  'The importer now **pages** the transcript and the view draws only what is near.',
  '',
  '- one\n- two\n- three',
  '',
  '```ts',
  ...Array.from({ length: 30 }, (_, i) => `export const value${i} = compute(${i}, "text ${i}"); // note`),
  '```',
  '',
  'And a closing paragraph with `inline code` and a [link](https://example.com).',
].join('\n');

function fixture(n: number): MessageView[] {
  const wire: Message[] = [];
  for (let i = 0; i < n; i++) {
    const id = `m${i}`;
    const base = {
      id,
      thread_id: 't1',
      parent_id: i ? `m${i - 1}` : null,
      model_id: null,
      requested_model_id: null,
      status: 'complete' as const,
      edit_of_id: null,
      provenance: {},
      usage: null,
      run_id: null,
      trace_id: '0'.repeat(32),
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    };
    if (i % 3 === 0)
      wire.push({
        ...base,
        role: 'user',
        parts: [{ type: 'text', text: `Question ${i}: ${LONG_MD.slice(0, 200)}` }],
      });
    else if (i % 3 === 1) {
      const parts: Part[] = [
        { type: 'reasoning', text: `Thinking about ${i}…` },
        { type: 'text', text: LONG_MD },
        { type: 'tool_call', call_id: `c${i}`, tool: 'Bash', args: { command: `ls -la /tmp/${i}` } },
      ];
      wire.push({ ...base, role: 'assistant', parts });
    } else
      wire.push({
        ...base,
        role: 'user',
        parts: [{ type: 'tool_result', call_id: `c${i - 1}`, ok: true, result: 'line\n'.repeat(2_000) }],
      });
  }
  return toMessageViews(wire);
}

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider>{ui}</Tooltip.Provider>
    </QueryClientProvider>,
  );

/** An IntersectionObserver that never reports anything (rows stay off screen). */
class StillObserver {
  static watched = 0;
  observe() {
    StillObserver.watched++;
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function list(messages: MessageView[]) {
  const scroller = createRef<HTMLDivElement>();
  return wrap(
    <div ref={scroller}>
      <MessageList
        messages={messages}
        threadId="t1"
        selected={null}
        onSelect={() => {}}
        jumpTo={null}
        cwd={null}
        scroller={scroller}
      />
    </div>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the conversation list draws a window', () => {
  it('draws the last few in full and the rest as their words', async () => {
    vi.stubGlobal('IntersectionObserver', StillObserver);
    const msgs = fixture(300).filter((m) => !m.folded);
    const { container } = list(msgs);
    await act(async () => {});
    const full = container.querySelectorAll('.thread__messages > li .msg');
    const lazy = container.querySelectorAll('.thread__messages > li [data-lazy]');
    expect(full.length).toBe(EAGER_TAIL);
    expect(lazy.length).toBe(msgs.length - EAGER_TAIL);
    // The words are there for the page's own find.
    expect(lazy[0]?.textContent).toContain('Question 0');
  });

  it('measures a 5,000-message thread: everything drawn, windowed, and the first page', async () => {
    const msgs = fixture(Number(process.env.PERF_N ?? 5_000));
    const time = async (ms: MessageView[], io: boolean) => {
      if (io) vi.stubGlobal('IntersectionObserver', StillObserver);
      else vi.stubGlobal('IntersectionObserver', undefined);
      const t0 = performance.now();
      const r = list(ms);
      await act(async () => {});
      const took = performance.now() - t0;
      const nodes = r.container.querySelectorAll('*').length;
      r.unmount();
      vi.unstubAllGlobals();
      return { took: Math.round(took), nodes };
    };
    // Everything drawn at once (how the list worked before) runs a jsdom worker out of
    // memory at 5,000 messages (and takes minutes at 1,000), so that figure is taken at 300.
    const all = await time(fixture(Number(process.env.PERF_ALL ?? 300)), false);
    const windowed = await time(msgs, true);
    const firstPage = await time(msgs.slice(-60), true);
    console.log(
      `[perf] all drawn, ${Number(process.env.PERF_ALL ?? 300)} messages: ${all.took} ms / ${all.nodes} nodes; ` +
        `5,000 messages (${msgs.filter((m) => !m.folded).length} rows) ` +
        `windowed ${windowed.took} ms / ${windowed.nodes} nodes; first page of 60 ${firstPage.took} ms / ${firstPage.nodes} nodes`,
    );
    expect(windowed.nodes).toBeLessThan(all.nodes);
    expect(firstPage.took).toBeLessThan(all.took);
  }, 300_000);
});
