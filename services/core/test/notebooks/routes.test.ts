/**
 * Notebook, note, source and search routes (notebooks/routes.ts): notebooks
 * and notes are Core's; sources, links, content, search and the embedding
 * status are Knowledge's, reached with this workspace's id. A notebook from
 * another workspace is never found; a Knowledge that is down shows 0 sources
 * rather than failing the list.
 */
import type { Note, Notebook, Source } from '@nvx/contracts';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { KnowledgeClient } from '../../src/knowledge/client';
import { MemoryNotebookRepo } from '../../src/notebooks/repo';
import { notebookRoutes } from '../../src/notebooks/routes';
import { errorHandler } from '../../src/obs/errors';
import { MemoryThreadRepo } from '../../src/threads/repo';

const WS = 'wsp_test';

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** A Knowledge stand-in that records every call and answers from `answers`. */
function fakeKn(answers: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const answer = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    calls.push({ method, path, ...(body !== undefined && { body }) });
    const key = `${method} ${path.split('?')[0]}`;
    const a = answers[key];
    if (a instanceof Error) throw a;
    return (typeof a === 'function' ? (a as (b: unknown) => unknown)(body) : (a ?? {})) as T;
  };
  const kn: KnowledgeClient = {
    get: (p) => answer('GET', p),
    post: (p, b) => answer('POST', p, b),
    put: (p, b) => answer('PUT', p, b),
    patch: (p, b) => answer('PATCH', p, b),
    del: async (p) => {
      await answer('DELETE', p);
    },
    stream: async (method, path, init) => {
      calls.push({ method, path, body: init.body });
      return new Response(JSON.stringify({ id: 'src_up', title: 'up.pdf' }), {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': '20', etag: 'abc' },
      });
    },
  };
  return { kn, calls };
}

const source = (id: string, title = id): Source => ({ id, title }) as Source;

let notebooks: MemoryNotebookRepo;
let threads: MemoryThreadRepo;
let app: Hono;
let calls: Call[];
let orphaned: string[];

function mount(answers: Record<string, unknown> = {}) {
  const f = fakeKn(answers);
  calls = f.calls;
  orphaned = [];
  app = new Hono();
  app.onError(errorHandler);
  app.route(
    '/',
    notebookRoutes({
      workspaceId: WS,
      notebooks,
      threads,
      kn: f.kn,
      flowStore: { orphan: async (_kind: string, id: string) => void orphaned.push(id) } as never,
    }) as unknown as Hono,
  );
}

async function call<T>(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    ...(body !== undefined && {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
}

beforeEach(() => {
  notebooks = new MemoryNotebookRepo();
  threads = new MemoryThreadRepo();
  mount();
});

describe('notebooks', () => {
  it('creates, lists with counts, opens, patches and deletes a notebook', async () => {
    mount({ 'GET /notebooks/nbk_x/stats': { sources: 3, ready: 3, chunks: 40 } });
    const made = await call<Notebook>('POST', '/notebooks', { title: 'Pumps', description: 'Manuals' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ title: 'Pumps', pinned: false, counts: { sources: 0, threads: 0 } });
    const id = made.body.id;
    expect(id).toMatch(/^nbk_/);

    await threads.createThread({ id: 'thr_1', workspace_id: WS, notebook_id: id });
    const list = await call<{ items: Notebook[] }>('GET', '/notebooks');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]?.counts).toMatchObject({ threads: 1, notes: 0 });

    const opened = await call<Notebook>('GET', `/notebooks/${id}`);
    expect(opened.body.last_opened_at).not.toBeNull();

    const patched = await call<Notebook>('PATCH', `/notebooks/${id}`, { pinned: true, grounded: true });
    expect(patched.body).toMatchObject({ pinned: true, grounded: true });
    expect((await call('PATCH', `/notebooks/${id}`, { nope: 1 })).status).toBe(400);
  });

  it('a Knowledge that is down shows 0 sources instead of failing the list', async () => {
    const n = await notebooks.create({ id: 'nbk_a', workspace_id: WS, title: 'A' });
    mount({ [`GET /notebooks/${n.id}/stats`]: new Error('down') });
    const list = await call<{ items: Notebook[] }>('GET', '/notebooks');
    expect(list.status).toBe(200);
    expect(list.body.items[0]?.counts.sources).toBe(0);
  });

  it("never finds another workspace's notebook", async () => {
    await notebooks.create({ id: 'nbk_other', workspace_id: 'wsp_other', title: 'Theirs' });
    expect((await call('GET', '/notebooks/nbk_other')).status).toBe(404);
    expect((await call('GET', '/notebooks/nbk_missing/sources')).status).toBe(404);
    expect((await call('POST', '/search', { query: 'x', notebook_id: 'nbk_other' })).status).toBe(404);
  });

  it('deleting unlinks its sources (keeping them) and keeps its flows as drafts', async () => {
    const n = await notebooks.create({ id: 'nbk_d', workspace_id: WS, title: 'D' });
    mount({ 'GET /notebooks/nbk_d/sources': [source('src_1'), source('src_2')] });
    expect((await call('DELETE', `/notebooks/${n.id}`)).status).toBe(204);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      '/notebooks/nbk_d/sources/src_1',
      '/notebooks/nbk_d/sources/src_2',
    ]);
    expect(orphaned).toEqual(['nbk_d']);
    expect(await notebooks.get('nbk_d')).toBeUndefined();
  });
});

describe("a notebook's sources", () => {
  beforeEach(async () => {
    await notebooks.create({ id: 'nbk_s', workspace_id: WS, title: 'S' });
  });

  it('lists them as { items } whether Knowledge answers an array or a page', async () => {
    mount({ 'GET /notebooks/nbk_s/sources': { items: [source('src_1')] } });
    const r = await call<{ items: Source[] }>('GET', '/notebooks/nbk_s/sources');
    expect(r.body.items.map((s) => s.id)).toEqual(['src_1']);
  });

  it('links, re-levels and unlinks a source', async () => {
    mount({
      'PUT /notebooks/nbk_s/sources/src_1': (b: unknown) => ({ id: 'src_1', ...(b as object) }),
    });
    expect((await call('POST', '/notebooks/nbk_s/sources', { source_id: 'src_1' })).status).toBe(201);
    expect((await call('POST', '/notebooks/nbk_s/sources', {})).status).toBe(400);
    await call('PATCH', '/notebooks/nbk_s/sources/src_1', { context_level: 'insights' });
    await call('PUT', '/notebooks/nbk_s/sources/src_1', { context_level: 'full' });
    expect((await call('DELETE', '/notebooks/nbk_s/sources/src_1')).status).toBe(204);
    expect(calls.map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body ?? null)}`)).toEqual([
      'PUT /notebooks/nbk_s/sources/src_1 {}',
      'PUT /notebooks/nbk_s/sources/src_1 {"context_level":"insights"}',
      'PUT /notebooks/nbk_s/sources/src_1 {"context_level":"full"}',
      'DELETE /notebooks/nbk_s/sources/src_1 null',
    ]);
  });
});

describe('deleting a notebook with everything in it', () => {
  it('deletes only the sources no other notebook uses, and only when asked', async () => {
    await notebooks.create({ id: 'nbk_gone', workspace_id: WS, title: 'Gone' });
    await notebooks.create({ id: 'nbk_keep', workspace_id: WS, title: 'Keep' });
    mount({
      'GET /notebooks/nbk_gone/sources': [source('src_only'), source('src_shared')],
      'GET /notebooks/nbk_keep/sources': [source('src_shared')],
    });
    expect((await call('DELETE', '/notebooks/nbk_gone?sources=delete')).status).toBe(204);
    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
    expect(deletes).toContain('/sources/src_only');
    expect(deletes).not.toContain('/sources/src_shared');
    expect(deletes).toContain('/notebooks/nbk_gone/sources/src_shared');
    expect(await notebooks.get('nbk_gone')).toBeUndefined();
  });

  it('keeps every source by default', async () => {
    await notebooks.create({ id: 'nbk_plain', workspace_id: WS, title: 'Plain' });
    mount({ 'GET /notebooks/nbk_plain/sources': [source('src_only')] });
    expect((await call('DELETE', '/notebooks/nbk_plain')).status).toBe(204);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/sources/src_only')).toBe(false);
  });
});

describe('notes', () => {
  it('writes, edits and removes a note, only in your own notebooks', async () => {
    await notebooks.create({ id: 'nbk_n', workspace_id: WS, title: 'N' });
    const made = await call<Note>('POST', '/notebooks/nbk_n/notes', {
      title: 'Idea',
      content_md: 'Prime first',
    });
    expect(made.status).toBe(201);
    expect((await call<{ items: Note[] }>('GET', '/notebooks/nbk_n/notes')).body.items).toHaveLength(1);
    const edited = await call<Note>('PATCH', `/notes/${made.body.id}`, { pinned: true });
    expect(edited.body).toMatchObject({ title: 'Idea' });
    expect((await call('DELETE', `/notes/${made.body.id}`)).status).toBe(204);
    expect((await call('PATCH', `/notes/${made.body.id}`, { title: 'x' })).status).toBe(404);
  });

  it('keeps an answer as a note titled by its first line', async () => {
    await notebooks.create({ id: 'nbk_k', workspace_id: WS, title: 'K' });
    await threads.createThread({ id: 'thr_k', workspace_id: WS });
    await threads.insertMessage({
      id: 'msg_a',
      thread_id: 'thr_k',
      parent_id: null,
      role: 'assistant',
      parts: [{ type: 'text', text: '## Priming the pump\n\nOpen V2, fill, close V2.' }],
      status: 'complete',
      trace_id: 't',
    });
    const r = await call<Note>('POST', '/messages/msg_a/to-note', { notebook_id: 'nbk_k' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ title: 'Priming the pump', kind: 'ai' });
    expect((await call('POST', '/messages/msg_none/to-note', { notebook_id: 'nbk_k' })).status).toBe(404);
  });
});

describe('sources', () => {
  it('adds text and URL sources with this workspace, and a thread as its transcript', async () => {
    await notebooks.create({ id: 'nbk_t', workspace_id: WS, title: 'T' });
    mount({ 'POST /sources': (b: unknown) => ({ id: 'src_new', ...(b as object) }) });
    await call('POST', '/sources', {
      kind: 'text',
      text: 'Owls hunt at night.',
      title: 'Owls',
      notebook_id: 'nbk_t',
    });
    await call('POST', '/sources', { kind: 'url', url: 'https://example.com/a' });
    await threads.createThread({ id: 'thr_t', workspace_id: WS, title: 'Pump chat' });
    await threads.insertMessage({
      id: 'msg_q',
      thread_id: 'thr_t',
      parent_id: null,
      role: 'user',
      parts: [{ type: 'text', text: 'How do I prime it?' }],
      status: 'complete',
      trace_id: 't',
    });
    await threads.insertMessage({
      id: 'msg_r',
      thread_id: 'thr_t',
      parent_id: 'msg_q',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Open V2 and fill the housing.' }],
      status: 'complete',
      trace_id: 't',
    });
    const r = await call<{ text: string; title: string }>('POST', '/sources', {
      kind: 'thread',
      thread_id: 'thr_t',
    });
    expect(r.status).toBe(201);
    expect(r.body.title).toBe('Pump chat');
    expect(r.body.text).toBe(
      '# Pump chat\n\n## Question\n\nHow do I prime it?\n\n## Answer\n\nOpen V2 and fill the housing.',
    );
    const sent = calls.filter((c) => c.path === '/sources').map((c) => c.body as Record<string, unknown>);
    expect(sent[0]).toMatchObject({ workspace_id: WS, kind: 'text', title: 'Owls', notebook_ids: ['nbk_t'] });
    expect(sent[1]).toMatchObject({ kind: 'url', url: 'https://example.com/a', notebook_ids: [] });
    expect((await call('POST', '/sources', { kind: 'thread', thread_id: 'thr_missing' })).status).toBe(404);
  });

  it('forwards an upload as multipart with the workspace and notebook', async () => {
    await notebooks.create({ id: 'nbk_u', workspace_id: WS, title: 'U' });
    const form = new FormData();
    form.set('file', new File(['%PDF-1.4'], 'up.pdf', { type: 'application/pdf' }));
    form.set('notebook_id', 'nbk_u');
    form.set('title', '  Manual  ');
    const res = await app.request('/sources', { method: 'POST', body: form });
    expect(res.status).toBe(201);
    const sent = calls.at(-1)?.body as FormData;
    expect(calls.at(-1)?.path).toBe('/sources/upload');
    expect(sent.get('workspace_id')).toBe(WS);
    expect(sent.get('notebook_ids')).toBe('nbk_u');
    expect(sent.get('title')).toBe('Manual');
    const empty = new FormData();
    expect((await app.request('/sources', { method: 'POST', body: empty })).status).toBe(400);
  });

  it('passes reads and edits through to Knowledge', async () => {
    mount({ 'GET /sources/src_1': source('src_1', 'Manual') });
    expect((await call<Source>('GET', '/sources/src_1')).body.title).toBe('Manual');
    await call('PATCH', '/sources/src_1', { title: 'Renamed' });
    await call('GET', '/sources/src_1/content');
    await call('POST', '/sources/src_1/retry');
    await call('POST', '/sources/src_1/refetch');
    await call('GET', '/sources/duplicates');
    await call('POST', '/sources/merge', { keep_id: 'src_1', drop_id: 'src_2' });
    await call('POST', '/sources/duplicates/dismiss', { a_id: 'src_1', b_id: 'src_2' });
    expect((await call('DELETE', '/sources/src_1')).status).toBe(204);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /sources/src_1',
      'PATCH /sources/src_1',
      'GET /sources/src_1/content',
      'POST /sources/src_1/retry',
      'POST /sources/src_1/refetch',
      `GET /duplicates?workspace_id=${WS}`,
      'POST /sources/merge',
      'POST /duplicates/dismiss',
      'DELETE /sources/src_1',
    ]);
  });

  it('SR1: reads a scan with OCR, and reads and saves the OCR setting through Knowledge', async () => {
    const view = { enabled: false, language: 'en', installed: { rapidocr: true, tesseract: false } };
    mount({
      'GET /maintenance/ocr': view,
      'PUT /maintenance/ocr': (b: unknown) => ({ ...view, ...(b as object) }),
    });
    await call('POST', '/sources/src_1/ocr');
    expect((await call<typeof view>('GET', '/knowledge/ocr')).body.installed.rapidocr).toBe(true);
    const saved = await call<typeof view>('PUT', '/knowledge/ocr', { enabled: true, language: 'DE ' });
    expect(saved.body).toMatchObject({ enabled: true, language: 'de' });
    // Anything that is not a language code, or any extra field, is refused before Knowledge hears of it.
    expect((await call('PUT', '/knowledge/ocr', { enabled: true, language: 'German please' })).status).toBe(
      400,
    );
    expect((await call('PUT', '/knowledge/ocr', { enabled: true, language: 'en', x: 1 })).status).toBe(400);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /sources/src_1/ocr',
      'GET /maintenance/ocr',
      'PUT /maintenance/ocr',
    ]);
  });

  it('serves an original file that can be shown, never run', async () => {
    const res = await app.request('/sources/src_1/file');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('etag')).toBe('abc');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
  });
});

describe('search and embeddings', () => {
  it('searches with this workspace, scoped to a notebook you own', async () => {
    await notebooks.create({ id: 'nbk_q', workspace_id: WS, title: 'Q' });
    mount({ 'POST /search': { hits: [] } });
    const r = await call('POST', '/search', { query: 'priming', notebook_id: 'nbk_q' });
    expect(r.status).toBe(200);
    expect(calls[0]?.body).toMatchObject({ query: 'priming', notebook_id: 'nbk_q', workspace_id: WS, k: 12 });
    expect((await call('POST', '/search', { query: '' })).status).toBe(400);
  });

  it('shows the embedding model and a re-embed’s progress, and asks for a check', async () => {
    const status = {
      active_model_key: 'local/a',
      configured_model_key: 'local/b',
      reembed: { status: 'running', done: 10, total: 40, percent: 25 },
    };
    mount({ 'GET /embeddings': status, 'POST /embeddings/check': status });
    expect((await call('GET', '/knowledge/embeddings')).body).toEqual(status);
    expect((await call('POST', '/knowledge/embeddings/check')).body).toEqual(status);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /embeddings', 'POST /embeddings/check']);
  });
});
