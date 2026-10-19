/**
 * Thread search matches the words people read, with several hits per thread (TS1), and a thread
 * can be exported whole, every branch, with its parts (EX3).
 */
import type { ThreadExport, ThreadSearchHit } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, harness } from '../support/harness';

let h: Harness;
afterEach(async () => h?.close());

describe('GET /threads/search', () => {
  it('does not match the stored JSON, finds several hits in a thread, and filters', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, 'Tell me about the zebrafinch and its song');
    await h.settle(sent.run_id);
    const again = await h.send(t, 'More about the zebrafinch please');
    await h.settle(again.run_id);

    // "type" and "text" are in every message's stored parts; nobody wrote them.
    const raw = await h.call<{ items: ThreadSearchHit[] }>('GET', '/threads/search?q=%22type%22');
    expect(raw.body.items).toEqual([]);

    const found = await h.call<{ items: ThreadSearchHit[] }>('GET', '/threads/search?q=zebrafinch');
    const mine = found.body.items.filter((i) => i.thread_id === t);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine.every((i) => i.snippet.includes('«zebrafinch»'))).toBe(true);
    expect(mine.every((i) => i.role === 'user' || i.role === 'assistant')).toBe(true);

    const own = await h.call<{ items: ThreadSearchHit[] }>('GET', '/threads/search?q=zebrafinch&who=mine');
    expect(own.body.items.every((i) => i.role === 'user')).toBe(true);
    const future = await h.call<{ items: ThreadSearchHit[] }>(
      'GET',
      '/threads/search?q=zebrafinch&from=2999-01-01',
    );
    expect(future.body.items).toEqual([]);
  });
});

describe('GET /threads/:id/export', () => {
  it('returns every message with its parts', async () => {
    h = await harness();
    const t = await h.newThread();
    const sent = await h.send(t, 'Export me');
    await h.settle(sent.run_id);
    const r = await h.call<ThreadExport>('GET', `/threads/${t}/export`);
    expect(r.status).toBe(200);
    expect(r.body.thread.id).toBe(t);
    expect(r.body.messages.length).toBeGreaterThanOrEqual(2);
    expect(r.body.truncated).toBe(false);
    expect(r.body.total).toBe(r.body.messages.length);
    expect(r.body.messages[0]?.parts[0]).toMatchObject({ type: 'text', text: 'Export me' });
    expect((await h.call('GET', '/threads/nope/export')).status).toBe(404);
  });
});
