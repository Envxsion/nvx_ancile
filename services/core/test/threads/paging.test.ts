/**
 * Paging a long path (GET /threads/:id/path?limit=&before=&include=) and the
 * cheap tree: the head end first, earlier pages by cursor, a page never
 * starting on a message that only carries tool results, and the old whole
 * response when no limit is asked.
 */
import type { BranchTree, Part, ThreadPath } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { NotOnPathError, pageRange, snapStart } from '../../src/threads/page';
import type { NewMessage } from '../../src/threads/repo';
import { harness } from '../support/harness';

type H = Awaited<ReturnType<typeof harness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const TRACE = '0'.repeat(32);
const text = (t: string): Part[] => [{ type: 'text', text: t }];

/** A straight thread of n messages m0..m(n-1), alternating user and assistant. */
async function longThread(hh: H, n: number, opts: { results?: number[] } = {}) {
  const t = await hh.newThread();
  const ms: NewMessage[] = [];
  const results = new Set(opts.results ?? []);
  for (let i = 0; i < n; i++) {
    const parts: Part[] = results.has(i)
      ? [{ type: 'tool_result', call_id: `c${i}`, ok: true, result: `out ${i}` }]
      : text(`message ${i}`);
    ms.push({
      id: `m${i}`,
      thread_id: t,
      parent_id: i === 0 ? null : `m${i - 1}`,
      role: results.has(i) || i % 2 === 0 ? 'user' : 'assistant',
      parts,
      status: 'complete',
      trace_id: TRACE,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    });
  }
  await hh.repo.insertMessages(ms);
  return t;
}

const ids = (p: ThreadPath) => p.messages.map((m) => m.id);

describe('pageRange', () => {
  const path = Array.from({ length: 10 }, (_, i) => `m${i}`);
  it('takes the tail, pages back by cursor, and reaches back to include a message', () => {
    expect(pageRange(path, {})).toEqual({ start: 0, end: 10 });
    expect(pageRange(path, { limit: 3 })).toEqual({ start: 7, end: 10 });
    expect(pageRange(path, { limit: 3, before: 'm7' })).toEqual({ start: 4, end: 7 });
    expect(pageRange(path, { limit: 3, before: 'm2' })).toEqual({ start: 0, end: 2 });
    expect(pageRange(path, { limit: 3, include: 'm5' })).toEqual({ start: 1, end: 10 });
    expect(() => pageRange(path, { limit: 3, before: 'nope' })).toThrow(NotOnPathError);
  });

  it('never starts on a message that only carries tool results', () => {
    const rows = [
      { role: 'assistant', parts: text('calls a tool') },
      { role: 'user', parts: [{ type: 'tool_result', call_id: 'a', ok: true, result: '' } as Part] },
      { role: 'tool', parts: [] },
    ];
    expect(snapStart(2, 0, rows)).toEqual({ start: 0, short: false });
    expect(snapStart(1, 1, rows.slice(1))).toEqual({ start: 0, short: true });
    expect(snapStart(0, 0, rows)).toEqual({ start: 0, short: false });
  });
});

describe('GET /threads/:id/path paging', () => {
  it('answers the whole path without a limit, as before', async () => {
    h = await harness();
    const t = await longThread(h, 12);
    const all = (await h.call<ThreadPath>('GET', `/threads/${t}/path`)).body;
    expect(all.messages).toHaveLength(12);
    expect(all).toMatchObject({ total: 12, start: 0, has_more: false, head_id: 'm11' });
  });

  it('sends the head end first and earlier pages in order by cursor', async () => {
    h = await harness();
    const t = await longThread(h, 150);
    const tail = (await h.call<ThreadPath>('GET', `/threads/${t}/path?limit=60`)).body;
    expect(ids(tail)).toEqual(Array.from({ length: 60 }, (_, i) => `m${90 + i}`));
    expect(tail).toMatchObject({ total: 150, start: 90, has_more: true });

    const before = tail.messages[0]?.id;
    const prev = (await h.call<ThreadPath>('GET', `/threads/${t}/path?limit=60&before=${before}`)).body;
    expect(ids(prev)).toEqual(Array.from({ length: 60 }, (_, i) => `m${30 + i}`));
    const first = (await h.call<ThreadPath>('GET', `/threads/${t}/path?limit=60&before=m30`)).body;
    expect(ids(first)).toEqual(Array.from({ length: 30 }, (_, i) => `m${i}`));
    expect(first).toMatchObject({ start: 0, has_more: false });

    const jump = (await h.call<ThreadPath>('GET', `/threads/${t}/path?limit=60&include=m40`)).body;
    expect(jump.start).toBe(36);
    expect(jump.messages.at(-1)?.id).toBe('m149');

    expect((await h.call('GET', `/threads/${t}/path?limit=60&before=nope`)).status).toBe(404);
    expect((await h.call('GET', `/threads/${t}/path?limit=0`)).status).toBe(400);
  });

  it('pages the branch being shown, with sibling counts', async () => {
    h = await harness();
    const t = await longThread(h, 80);
    // A fork at m69: b70..b74 beside m70..m79.
    await h.repo.insertMessages(
      Array.from({ length: 5 }, (_, i) => ({
        id: `b${70 + i}`,
        thread_id: t,
        parent_id: i === 0 ? 'm69' : `b${69 + i}`,
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        parts: text(`branch ${i}`),
        status: 'complete' as const,
        trace_id: TRACE,
        created_at: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString(),
      })),
    );
    const b = (await h.call<ThreadPath>('GET', `/threads/${t}/path?head=b74&limit=10`)).body;
    expect(ids(b)).toEqual(['m65', 'm66', 'm67', 'm68', 'm69', 'b70', 'b71', 'b72', 'b73', 'b74']);
    expect(b.messages.find((m) => m.id === 'b70')?.siblings).toMatchObject({ index: 1, count: 2 });
    expect(b).toMatchObject({ total: 75, start: 65, has_more: true });
    const main = (await h.call<ThreadPath>('GET', `/threads/${t}/path?head=m79&limit=5`)).body;
    expect(ids(main)).toEqual(['m75', 'm76', 'm77', 'm78', 'm79']);
  });

  it('reaches back so tool results arrive with the answer that asked for them', async () => {
    h = await harness();
    // m7 and m8 only carry tool results; a page of 3 would start on m7.
    const t = await longThread(h, 10, { results: [7, 8] });
    const p = (await h.call<ThreadPath>('GET', `/threads/${t}/path?limit=3`)).body;
    expect(ids(p)).toEqual(['m6', 'm7', 'm8', 'm9']);
    expect(p.start).toBe(6);
  });

  it('works out a 12,000-message path and its tree quickly', async () => {
    h = await harness();
    const t = await longThread(h, 12_000);
    const t0 = performance.now();
    const p = (await h.call<ThreadPath>('GET', `/threads/${t}/path?limit=60`)).body;
    const pathMs = performance.now() - t0;
    expect(p.messages).toHaveLength(60);
    const t1 = performance.now();
    const tree = (await h.call<BranchTree>('GET', `/threads/${t}/tree`)).body;
    const treeMs = performance.now() - t1;
    expect(tree.total).toBe(12_000);
    expect(tree.nodes).toHaveLength(1);
    expect(tree.nodes[0]?.preview).toBe('message 0');
    // Generous bounds for a slow CI box; locally both are tens of milliseconds.
    expect(pathMs).toBeLessThan(1_500);
    expect(treeMs).toBeLessThan(1_500);
  });
});
