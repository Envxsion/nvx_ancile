/**
 * The knowledge client (knowledge/client.ts): every call carries the service
 * token and a trace; Knowledge's errors arrive as NVX Ancile's own; a service
 * that does not answer says so plainly; reads retry transient failures and
 * writes never do; stream() passes bodies and responses through untouched.
 */
import { AncileError } from '@nvx/contracts';
import { describe, expect, it } from 'vitest';
import { knowledgeClient } from '../../src/knowledge/client';

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function fakeFetch(replies: (Response | Error)[]) {
  const seen: Seen[] = [];
  const fetch = (async (input: URL | string, init: RequestInit = {}) => {
    seen.push({
      url: String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: init.body,
    });
    const next = replies.shift();
    if (!next) throw new Error('no reply left');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const kn = (replies: (Response | Error)[]) => {
  const f = fakeFetch(replies);
  return {
    client: knowledgeClient({ baseUrl: 'http://kn.test:7710', serviceToken: 'tok', fetch: f.fetch }),
    seen: f.seen,
  };
};

describe('the knowledge client', () => {
  it('calls /kn/v1 with the service token, a trace and JSON', async () => {
    const { client, seen } = kn([json(200, { ok: 1 })]);
    expect(await client.post('/search', { query: 'x' })).toEqual({ ok: 1 });
    expect(seen[0]?.url).toBe('http://kn.test:7710/kn/v1/search');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer tok');
    expect(seen[0]?.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(seen[0]?.headers.get('content-type')).toBe('application/json');
    expect(seen[0]?.body).toBe('{"query":"x"}');
  });

  it("turns Knowledge's error into NVX Ancile's own, code, title and hint intact", async () => {
    const { client } = kn([
      json(422, { error: { code: 'request.invalid', title: 'The query is empty', hint: 'Type something.' } }),
    ]);
    const err = await client.post('/search', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AncileError);
    expect(err).toMatchObject({
      code: 'request.invalid',
      title: 'The query is empty',
      hint: 'Type something.',
      status: 422,
    });
  });

  it('an answer that is not an error body still says what happened', async () => {
    const { client } = kn([new Response('oops', { status: 500 })]);
    const err = await client.post('/x').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'knowledge.failed', status: 500, retryable: true });
  });

  it('reads retry a transient failure; writes do not', async () => {
    const down = new TypeError('fetch failed');
    const r = kn([down, json(200, [1, 2])]);
    expect(await r.client.get('/sources')).toEqual([1, 2]);
    expect(r.seen).toHaveLength(2);

    const w = kn([down, json(200, {})]);
    const err = await w.client.put('/notebooks/n/sources/s', {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'knowledge.unavailable', status: 503 });
    expect(w.seen).toHaveLength(1);
  });

  it('a permanent error is not retried', async () => {
    const r = kn([json(404, { error: { code: 'request.not_found', title: 'Gone', hint: 'Refresh.' } })]);
    await expect(r.client.get('/sources/x')).rejects.toMatchObject({ code: 'request.not_found' });
    expect(r.seen).toHaveLength(1);
  });

  it('204 is undefined, and delete and patch use their methods', async () => {
    const r = kn([new Response(null, { status: 204 }), json(200, { title: 'B' })]);
    expect(await r.client.del('/sources/a')).toBeUndefined();
    expect(await r.client.patch('/sources/a', { title: 'B' })).toEqual({ title: 'B' });
    expect(r.seen.map((s) => s.method)).toEqual(['DELETE', 'PATCH']);
  });

  it('stream passes the body and response through, and maps failures the same way', async () => {
    const file = new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } });
    const r = kn([
      file,
      json(413, { error: { code: 'source.too_large', title: 'Too large', hint: 'Smaller.' } }),
      new TypeError('x'),
    ]);
    const form = new FormData();
    form.set('a', 'b');
    const res = await r.client.stream('POST', '/sources/upload', { body: form });
    expect(await res.text()).toBe('%PDF');
    expect(r.seen[0]?.body).toBe(form);
    expect(r.seen[0]?.headers.get('authorization')).toBe('Bearer tok');
    await expect(r.client.stream('POST', '/sources/upload', { body: form })).rejects.toMatchObject({
      code: 'source.too_large',
      status: 413,
    });
    await expect(r.client.stream('GET', '/sources/x/file', {})).rejects.toMatchObject({
      code: 'knowledge.unavailable',
    });
  });
});
