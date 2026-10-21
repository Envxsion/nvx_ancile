/**
 * Notebook, note, source and search routes (notebooks/routes.ts): notebooks
 * and notes are Core's; sources, links, content, search and the embedding
 * status are Knowledge's, reached with this workspace's id. A notebook from
 * another workspace is never found; a Knowledge that is down shows 0 sources
 * rather than failing the list.
 */
import type { DeleteNotebookResult, Note, Notebook, Source } from '@nvx/contracts';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { KnowledgeClient } from '../../src/knowledge/client';
import { MemoryLinkStore } from '../../src/links/store';
import { MemoryNotebookRepo } from '../../src/notebooks/repo';
import { notebookRoutes } from '../../src/notebooks/routes';
import { errorHandler } from '../../src/obs/errors';
import type { ProRemoval } from '../../src/pro/types';
import { getEffectiveScope } from '../../src/scopes';
import { MemoryThreadRepo } from '../../src/threads/repo';
import { ThreadBackedScopes } from './delete-fakes';

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
let scopes: ThreadBackedScopes;
let links: MemoryLinkStore;
let app: Hono;
let calls: Call[];
let orphaned: string[];
/** Threads a run is answering in. */
let busy: Set<string>;
/** Folders the Claude Code module was told to dismiss, by notebook. */
let dismissed: string[];
/** What Pro was told is gone. */
let gone: ProRemoval[];
let cleared: string[];

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
      verdictCache: { clear: async (id: string) => void cleared.push(id) },
      runs: { activeForThread: async (id: string) => (busy.has(id) ? [{} as never] : []) },
      claudeCode: { dismissNotebook: async (id: string) => void dismissed.push(id) },
      gone: (e) => void gone.push(e),
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
  scopes = new ThreadBackedScopes(threads, notebooks);
  links = new MemoryLinkStore();
  notebooks.wire({ threads, scopes, links });
  busy = new Set();
  dismissed = [];
  gone = [];
  cleared = [];
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
  const wsThread = (id: string, notebook: string | null, extra: object = {}) =>
    threads.createThread({ id, workspace_id: WS, notebook_id: notebook, title: id, ...extra });

  it('deletes only the sources no other notebook uses, and counts what it did', async () => {
    await notebooks.create({ id: 'nbk_gone', workspace_id: WS, title: 'Gone' });
    await notebooks.create({ id: 'nbk_keep', workspace_id: WS, title: 'Keep' });
    mount({
      'GET /notebooks/nbk_gone/sources': [source('src_only'), source('src_shared')],
      'GET /notebooks/nbk_keep/sources': [source('src_shared')],
    });
    const r = await call<DeleteNotebookResult>('DELETE', '/notebooks/nbk_gone?contents=delete');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ threads_trashed: 0, sources_deleted: 1, sources_kept: 1 });
    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
    expect(deletes).toContain('/sources/src_only');
    expect(deletes).not.toContain('/sources/src_shared');
    expect(deletes).toContain('/notebooks/nbk_gone/sources/src_shared');
    expect(await notebooks.get('nbk_gone')).toBeUndefined();
    expect(gone).toEqual([
      { kind: 'source', id: 'src_only' },
      { kind: 'notebook', id: 'nbk_gone' },
    ]);
    expect(cleared).toEqual(['nbk_gone']);
    expect(orphaned).toEqual(['nbk_gone']);
  });

  it('still takes ?sources=delete as the older name for it', async () => {
    await notebooks.create({ id: 'nbk_old', workspace_id: WS, title: 'Old' });
    const r = await call<DeleteNotebookResult>('DELETE', '/notebooks/nbk_old?sources=delete');
    expect(r.status).toBe(200);
    expect(r.body.threads_trashed).toBe(0);
  });

  it('trashes every thread of the notebook, archived ones too, and not the others', async () => {
    await notebooks.create({ id: 'nbk_all', workspace_id: WS, title: 'All' });
    await notebooks.create({ id: 'nbk_other', workspace_id: WS, title: 'Other' });
    await wsThread('thr_live', 'nbk_all');
    await wsThread('thr_arch', 'nbk_all');
    await threads.setFields(WS, 'thr_arch', { archived_at: '2026-10-01T00:00:00.000Z' });
    await wsThread('thr_old', 'nbk_all');
    await threads.setFields(WS, 'thr_old', { deleted_at: '2026-10-02T00:00:00.000Z' });
    await wsThread('thr_else', 'nbk_other');
    const r = await call<DeleteNotebookResult>('DELETE', '/notebooks/nbk_all?contents=delete');
    expect(r.status).toBe(200);
    // The one already in the Trash is not counted twice.
    expect(r.body.threads_trashed).toBe(2);
    const trash = await threads.listTrash(WS);
    expect(trash.map((t) => t.id).sort()).toEqual(['thr_arch', 'thr_live', 'thr_old']);
    expect(await threads.getThread('thr_else')).toBeDefined();
    // They have left the notebook, so a restore puts them back outside it.
    expect(trash.every((t) => t.notebook_id === null)).toBe(true);
  });

  it('refuses with 409 while a thread is answering, and changes nothing', async () => {
    await notebooks.create({ id: 'nbk_busy', workspace_id: WS, title: 'Busy' });
    await wsThread('thr_a', 'nbk_busy');
    await wsThread('thr_b', 'nbk_busy');
    busy.add('thr_b');
    mount({ 'GET /notebooks/nbk_busy/sources': [source('src_1')] });
    const r = await call<{ error: { code: string; title: string; detail?: string } }>(
      'DELETE',
      '/notebooks/nbk_busy?contents=delete',
    );
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('notebook.delete_blocked');
    expect(r.body.error.detail).toContain('thr_b');
    expect(await notebooks.get('nbk_busy')).toBeDefined();
    expect(await threads.getThread('thr_a')).toBeDefined();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(dismissed).toEqual([]);
  });

  it('fails with 503 and changes nothing when Knowledge cannot be read', async () => {
    await notebooks.create({ id: 'nbk_down', workspace_id: WS, title: 'Down' });
    await wsThread('thr_1', 'nbk_down');
    mount({ 'GET /notebooks/nbk_down/sources': new Error('knowledge is down') });
    const r = await call<{ error: { code: string } }>('DELETE', '/notebooks/nbk_down?contents=delete');
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('notebook.delete_needs_knowledge');
    expect(await notebooks.get('nbk_down')).toBeDefined();
    expect(await threads.getThread('thr_1')).toBeDefined();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('does not swallow a failed unlink: the notebook stays so a retry finishes the job', async () => {
    await notebooks.create({ id: 'nbk_half', workspace_id: WS, title: 'Half' });
    await notebooks.create({ id: 'nbk_keep', workspace_id: WS, title: 'Keep' });
    mount({
      'GET /notebooks/nbk_half/sources': [source('src_shared')],
      'GET /notebooks/nbk_keep/sources': [source('src_shared')],
      'DELETE /notebooks/nbk_half/sources/src_shared': new Error('knowledge refused'),
    });
    const r = await call('DELETE', '/notebooks/nbk_half?contents=delete');
    expect(r.status).toBe(500);
    expect(await notebooks.get('nbk_half')).toBeDefined();
    expect(gone).toEqual([]);
  });

  it('takes the notebook last: a failed source delete leaves it, its notes and its links', async () => {
    await notebooks.create({ id: 'nbk_fail', workspace_id: WS, title: 'Fail' });
    await notebooks.createNote({
      id: 'not_1',
      notebook_id: 'nbk_fail',
      kind: 'human',
      title: 'N',
      content_md: 'x',
    });
    mount({
      'GET /notebooks/nbk_fail/sources': [source('src_only')],
      'DELETE /sources/src_only': new Error('knowledge refused'),
    });
    expect((await call('DELETE', '/notebooks/nbk_fail?contents=delete')).status).toBe(500);
    expect(await notebooks.get('nbk_fail')).toBeDefined();
    expect(await notebooks.getNote('not_1')).toBeDefined();
    expect(dismissed).toEqual([]);
  });

  it('keeps every source and every thread by default (the plain delete)', async () => {
    await notebooks.create({ id: 'nbk_plain', workspace_id: WS, title: 'Plain' });
    await wsThread('thr_p', 'nbk_plain');
    mount({ 'GET /notebooks/nbk_plain/sources': [source('src_only')] });
    expect((await call('DELETE', '/notebooks/nbk_plain')).status).toBe(204);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/sources/src_only')).toBe(false);
    const t = await threads.getThread('thr_p');
    expect(t).toBeDefined();
    expect(t?.notebook_id).toBeNull();
    expect(gone).toEqual([{ kind: 'notebook', id: 'nbk_plain' }]);
  });

  it('the plain delete still works when Knowledge is down', async () => {
    await notebooks.create({ id: 'nbk_tol', workspace_id: WS, title: 'Tolerant' });
    mount({ 'GET /notebooks/nbk_tol/sources': new Error('down') });
    expect((await call('DELETE', '/notebooks/nbk_tol')).status).toBe(204);
    expect(await notebooks.get('nbk_tol')).toBeUndefined();
  });
});

describe('what a deleted notebook leaves behind', () => {
  const thread = (id: string, notebook: string | null) =>
    threads.createThread({ id, workspace_id: WS, notebook_id: notebook, title: id });

  it('a thread from a private notebook stays private, and stays so after the Trash and a restore', async () => {
    await notebooks.create({ id: 'nbk_priv', workspace_id: WS, title: 'Secret' });
    await scopes.setPrivate('nbk_priv', true);
    await thread('thr_p', 'nbk_priv');
    await thread('thr_trashed', 'nbk_priv');
    await threads.setFields(WS, 'thr_trashed', { deleted_at: '2026-10-02T00:00:00.000Z' });
    const before = await getEffectiveScope(scopes, { threadId: 'thr_p' });
    expect(before.private).toBe(true);

    expect((await call('DELETE', '/notebooks/nbk_priv')).status).toBe(204);

    for (const id of ['thr_p', 'thr_trashed']) {
      const eff = await getEffectiveScope(scopes, { threadId: id });
      expect(eff.notebook_id).toBeNull();
      expect(eff.scope.data_leaves_machine).toBe(false);
      expect(eff.scope.engines).toEqual(['gateway_local']);
    }
    // Trash it and restore it: the limits are on the thread, so they come back with it.
    await threads.setFields(WS, 'thr_p', { deleted_at: '2026-10-03T00:00:00.000Z' });
    await threads.setFields(WS, 'thr_p', { deleted_at: null });
    const again = await getEffectiveScope(scopes, { threadId: 'thr_p' });
    expect(again.scope.data_leaves_machine).toBe(false);
    expect(again.scope.engines).toEqual(['gateway_local']);
  });

  it('copies a notebook-level scope patch onto its threads, the stricter value winning', async () => {
    await notebooks.create({ id: 'nbk_lim', workspace_id: WS, title: 'Limited' });
    await scopes.mergePatch('notebook', 'nbk_lim', {
      network: false,
      tools_deny: ['shell.run'],
      engines: ['gateway_local', 'gateway_cloud'],
    });
    await thread('thr_plain', 'nbk_lim');
    await thread('thr_own', 'nbk_lim');
    await scopes.mergePatch('thread', 'thr_own', { engines: ['gateway_local'], tools_deny: ['fs.write'] });
    await call('DELETE', '/notebooks/nbk_lim');
    const plain = await getEffectiveScope(scopes, { threadId: 'thr_plain' });
    expect(plain.scope.network).toBe(false);
    expect(plain.scope.tools_deny).toEqual(['shell.run']);
    expect(plain.scope.engines).toEqual(['gateway_local', 'gateway_cloud']);
    const own = await getEffectiveScope(scopes, { threadId: 'thr_own' });
    // What the thread chose for itself is kept, and the notebook's limits are added to it.
    expect(own.scope.engines).toEqual(['gateway_local']);
    expect(own.scope.tools_deny.sort()).toEqual(['fs.write', 'shell.run']);
    expect(own.scope.network).toBe(false);
  });

  it('deletes its notes with it, and the note routes no longer find them', async () => {
    await notebooks.create({ id: 'nbk_notes', workspace_id: WS, title: 'Notes' });
    const made = await call<Note>('POST', '/notebooks/nbk_notes/notes', { title: 'Idea', content_md: 'x' });
    expect((await call('DELETE', '/notebooks/nbk_notes')).status).toBe(204);
    expect(await notebooks.getNote(made.body.id)).toBeUndefined();
    expect(await notebooks.notes('nbk_notes')).toEqual([]);
    expect((await call('PATCH', `/notes/${made.body.id}`, { title: 'y' })).status).toBe(404);
  });

  it('removes context links that end at the notebook, from either side', async () => {
    await notebooks.create({ id: 'nbk_l', workspace_id: WS, title: 'L' });
    await notebooks.create({ id: 'nbk_m', workspace_id: WS, title: 'M' });
    await links.create({
      id: 'lnk_in',
      workspace_id: WS,
      from_kind: 'thread',
      from_id: 'thr_x',
      to_kind: 'notebook',
      to_id: 'nbk_l',
      kind: 'sources',
    });
    await links.create({
      id: 'lnk_out',
      workspace_id: WS,
      from_kind: 'notebook',
      from_id: 'nbk_l',
      to_kind: 'notebook',
      to_id: 'nbk_m',
      kind: 'sources',
    });
    await links.create({
      id: 'lnk_keep',
      workspace_id: WS,
      from_kind: 'thread',
      from_id: 'thr_x',
      to_kind: 'notebook',
      to_id: 'nbk_m',
      kind: 'sources',
    });
    await call('DELETE', '/notebooks/nbk_l');
    expect([...links.rows.keys()]).toEqual(['lnk_keep']);
  });

  it('marks the Claude Code folder dismissed before the notebook goes', async () => {
    await notebooks.create({ id: 'nbk_cc', workspace_id: WS, title: 'Folder' });
    await call('DELETE', '/notebooks/nbk_cc');
    expect(dismissed).toEqual(['nbk_cc']);
  });

  it('tells Pro when a single source is deleted', async () => {
    mount();
    expect((await call('DELETE', '/sources/src_9')).status).toBe(204);
    expect(gone).toEqual([{ kind: 'source', id: 'src_9' }]);
  });

  it('tells Pro about the source a merge folds away', async () => {
    mount();
    expect((await call('POST', '/sources/merge', { keep_id: 'src_keep', drop_id: 'src_drop' })).status).toBe(
      200,
    );
    expect(gone).toEqual([{ kind: 'source', id: 'src_drop' }]);
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
