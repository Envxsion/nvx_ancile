/**
 * ------------------------------------------------------------------
 *  Title    |  Notebook, note, source and search routes
 *  Ref      |  DESIGN.md §4.1, §4.2 · ROADMAP.md Phase 3
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The Cockpit's knowledge API on one origin. Notebooks
 *           |  and notes are Core's; sources, their content, notebook
 *           |  links and search are the knowledge service's, reached
 *           |  through the knowledge client with this workspace's id.
 *  How      |  A past thread added as a source is turned into text
 *           |  here (its active branch, as markdown), because Core is
 *           |  the one that owns threads. A file upload is re-sent as
 *           |  multipart with the workspace and notebook attached.
 *  Note     |  Counts on the notebook list come from three places; a
 *           |  knowledge service that is down shows 0 sources rather
 *           |  than failing the whole list.
 * ------------------------------------------------------------------
 */

import {
  AddSourceRequest,
  CreateNotebookRequest,
  CreateNoteRequest,
  DismissDuplicateRequest,
  MergeSourcesRequest,
  MessageToNoteRequest,
  type Notebook,
  PatchNotebookRequest,
  PatchNotebookSourceRequest,
  PatchNoteRequest,
  PatchSourceRequest,
  SearchRequest,
  type Source,
} from '@nvx/contracts';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import type { AppEnv } from '../app';
import type { FlowStore } from '../flows/store';
import { body } from '../http/body';
import type { KnowledgeClient } from '../knowledge/client';
import { badRequest, notFound } from '../obs/errors';
import { ancestorPath } from '../threads/path';
import { asTree, type ThreadRepo, textOf } from '../threads/repo';
import type { NotebookRecord, NotebookRepo } from './repo';

export interface NotebookRouteDeps {
  workspaceId: string;
  notebooks: NotebookRepo;
  threads: ThreadRepo;
  kn: KnowledgeClient;
  /** Deleting a notebook keeps its flows as inactive workspace drafts. */
  flowStore?: Pick<FlowStore, 'orphan'>;
}

type Stats = { sources: number; ready: number; chunks: number };

const enc = encodeURIComponent;

export function notebookRoutes(deps: NotebookRouteDeps) {
  const r = new Hono<AppEnv>();
  const { notebooks, kn, workspaceId } = deps;

  const notebook = async (id: string) => {
    const n = await notebooks.get(id);
    if (!n || n.workspace_id !== workspaceId) throw notFound('That notebook');
    return n;
  };

  /** The knowledge service lists as a bare array; the API always answers { items }. */
  const sourcesOf = async (id: string): Promise<Source[]> => {
    const r = await kn.get<Source[] | { items: Source[] }>(`/notebooks/${enc(id)}/sources`);
    return Array.isArray(r) ? r : r.items;
  };

  const stats = (id: string): Promise<Stats> =>
    kn.get<Stats>(`/notebooks/${enc(id)}/stats`).catch(() => ({ sources: 0, ready: 0, chunks: 0 }));

  const out = async (
    n: NotebookRecord,
    counts?: { threads?: number; notes?: number; sources?: number },
  ): Promise<Notebook> => ({
    id: n.id,
    title: n.title,
    description: n.description,
    icon: n.icon,
    color: n.color,
    pinned: n.pinned_at !== null,
    grounded: n.grounded,
    archived_at: n.archived_at,
    last_opened_at: n.last_opened_at,
    created_at: n.created_at,
    updated_at: n.updated_at,
    counts: {
      sources: counts?.sources ?? (await stats(n.id)).sources,
      threads: counts?.threads ?? 0,
      notes: counts?.notes ?? 0,
    },
  });

  /* ---- Notebooks -------------------------------------------------------- */

  r.get('/notebooks', async (c) => {
    const list = await notebooks.list(workspaceId);
    const [threadCounts, noteCounts, sourceCounts] = await Promise.all([
      deps.threads.countByNotebook(workspaceId),
      notebooks.noteCounts(workspaceId),
      Promise.all(list.map((n) => stats(n.id))),
    ]);
    const items = await Promise.all(
      list.map((n, i) =>
        out(n, {
          threads: threadCounts.get(n.id) ?? 0,
          notes: noteCounts.get(n.id) ?? 0,
          sources: sourceCounts[i]?.sources ?? 0,
        }),
      ),
    );
    return c.json({ items, next_cursor: null });
  });

  r.post('/notebooks', async (c) => {
    const req = await body(c, CreateNotebookRequest);
    const n = await notebooks.create({ id: `nbk_${ulid()}`, workspace_id: workspaceId, ...req });
    return c.json(await out(n, { sources: 0 }), 201);
  });

  r.get('/notebooks/:id', async (c) => {
    const n = await notebook(c.req.param('id'));
    const opened = (await notebooks.patch(n.id, { opened: true })) ?? n;
    const [threadCounts, noteCounts] = await Promise.all([
      deps.threads.countByNotebook(workspaceId),
      notebooks.noteCounts(workspaceId),
    ]);
    return c.json(
      await out(opened, { threads: threadCounts.get(n.id) ?? 0, notes: noteCounts.get(n.id) ?? 0 }),
    );
  });

  r.patch('/notebooks/:id', async (c) => {
    const n = await notebook(c.req.param('id'));
    const req = await body(c, PatchNotebookRequest);
    const next = await notebooks.patch(n.id, req);
    return c.json(await out(next ?? n));
  });

  r.delete('/notebooks/:id', async (c) => {
    const n = await notebook(c.req.param('id'));
    // Sources stay in the workspace; only this notebook's links go.
    const linked = await sourcesOf(n.id).catch(() => []);
    await Promise.all(
      linked.map((s) => kn.del(`/notebooks/${enc(n.id)}/sources/${enc(s.id)}`).catch(() => undefined)),
    );
    await notebooks.remove(n.id);
    // A flow is work: it outlives its notebook, as an inactive workspace draft.
    await deps.flowStore?.orphan('notebook', n.id);
    return c.body(null, 204);
  });

  /* ---- A notebook's sources ---------------------------------------------- */

  r.get('/notebooks/:id/sources', async (c) => {
    const n = await notebook(c.req.param('id'));
    return c.json({ items: await sourcesOf(n.id), next_cursor: null });
  });

  const link = async (notebookId: string, sourceId: string, level?: string) => {
    const n = await notebook(notebookId);
    return kn.put<Source>(
      `/notebooks/${enc(n.id)}/sources/${enc(sourceId)}`,
      level ? { context_level: level } : {},
    );
  };

  r.put('/notebooks/:id/sources/:sid', async (c) => {
    const req = (await c.req.json().catch(() => ({}))) as { context_level?: string };
    return c.json(await link(c.req.param('id'), c.req.param('sid'), req.context_level));
  });

  r.patch('/notebooks/:id/sources/:sid', async (c) => {
    const req = await body(c, PatchNotebookSourceRequest);
    return c.json(await link(c.req.param('id'), c.req.param('sid'), req.context_level));
  });

  r.post('/notebooks/:id/sources', async (c) => {
    const req = (await c.req.json()) as { source_id?: string; context_level?: string };
    if (!req.source_id) throw badRequest('source_id: which source to add');
    return c.json(await link(c.req.param('id'), req.source_id, req.context_level), 201);
  });

  r.delete('/notebooks/:id/sources/:sid', async (c) => {
    const n = await notebook(c.req.param('id'));
    await kn.del(`/notebooks/${enc(n.id)}/sources/${enc(c.req.param('sid'))}`);
    return c.body(null, 204);
  });

  /* ---- Notes ---------------------------------------------------------- */

  r.get('/notebooks/:id/notes', async (c) => {
    const n = await notebook(c.req.param('id'));
    return c.json({ items: await notebooks.notes(n.id), next_cursor: null });
  });

  r.post('/notebooks/:id/notes', async (c) => {
    const n = await notebook(c.req.param('id'));
    const req = await body(c, CreateNoteRequest);
    const note = await notebooks.createNote({
      id: `not_${ulid()}`,
      notebook_id: n.id,
      kind: 'human',
      title: req.title,
      content_md: req.content_md,
    });
    return c.json(note, 201);
  });

  const ownNote = async (id: string) => {
    const note = await notebooks.getNote(id);
    if (!note) throw notFound('That note');
    await notebook(note.notebook_id);
    return note;
  };

  r.patch('/notes/:id', async (c) => {
    const note = await ownNote(c.req.param('id'));
    const req = await body(c, PatchNoteRequest);
    return c.json((await notebooks.patchNote(note.id, req)) ?? note);
  });

  r.delete('/notes/:id', async (c) => {
    const note = await ownNote(c.req.param('id'));
    await notebooks.removeNote(note.id);
    return c.body(null, 204);
  });

  r.post('/messages/:id/to-note', async (c) => {
    const req = await body(c, MessageToNoteRequest);
    const m = await deps.threads.getMessage(c.req.param('id'));
    if (!m || m.deleted_at) throw notFound('That message');
    const t = await deps.threads.getThread(m.thread_id);
    if (!t || t.workspace_id !== workspaceId) throw notFound('That message');
    const n = await notebook(req.notebook_id);
    const text = textOf(m.parts).trim();
    if (!text) throw badRequest('That message has no text to keep');
    const firstLine =
      text
        .split('\n')
        .find((l) => l.trim())
        ?.replace(/^#+\s*/, '') ?? 'Kept answer';
    const note = await notebooks.createNote({
      id: `not_${ulid()}`,
      notebook_id: n.id,
      kind: m.role === 'assistant' ? 'ai' : 'human',
      title: req.title ?? (firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine),
      content_md: text,
      from_message_id: m.id,
    });
    return c.json(note, 201);
  });

  /* ---- Sources -------------------------------------------------------- */

  /** A thread's active branch as markdown, to add as a source. */
  const transcript = async (threadId: string): Promise<{ title: string; text: string }> => {
    const t = await deps.threads.getThread(threadId);
    if (!t || t.workspace_id !== workspaceId) throw notFound('That thread');
    const all = asTree(await deps.threads.messages(t.id));
    const byId = new Map(all.map((m) => [m.id, m] as const));
    const head = t.active_head_id && byId.has(t.active_head_id) ? t.active_head_id : all.at(-1)?.id;
    const path = head ? ancestorPath(byId, head) : [];
    const text = path
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `## ${m.role === 'user' ? 'Question' : 'Answer'}\n\n${textOf(m.parts).trim()}`)
      .join('\n\n');
    if (!text.trim()) throw badRequest('That thread has nothing in it yet');
    return { title: t.title, text: `# ${t.title}\n\n${text}` };
  };

  r.post('/sources', async (c) => {
    const type = c.req.header('content-type') ?? '';
    if (type.startsWith('multipart/form-data')) {
      const form = await c.req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) throw badRequest('file: choose a file to add');
      const notebookId = form.get('notebook_id');
      if (typeof notebookId === 'string' && notebookId) await notebook(notebookId);
      const fwd = new FormData();
      fwd.set('file', file, file.name);
      fwd.set('workspace_id', workspaceId);
      if (typeof notebookId === 'string' && notebookId) fwd.set('notebook_ids', notebookId);
      const title = form.get('title');
      if (typeof title === 'string' && title.trim()) fwd.set('title', title.trim());
      const res = await kn.stream('POST', '/sources/upload', { body: fwd });
      return c.json(await res.json(), 201);
    }
    const req = await body(c, AddSourceRequest);
    if (req.notebook_id) await notebook(req.notebook_id);
    const thread = req.kind === 'thread' && req.thread_id ? await transcript(req.thread_id) : null;
    const created = await kn.post<Source>('/sources', {
      workspace_id: workspaceId,
      kind: req.kind,
      ...(req.url && { url: req.url }),
      ...(thread ? { text: thread.text, thread_id: req.thread_id, title: req.title ?? thread.title } : {}),
      ...(req.kind === 'text' && { text: req.text }),
      ...(req.title && !thread && { title: req.title }),
      notebook_ids: req.notebook_id ? [req.notebook_id] : [],
    });
    return c.json(created, 201);
  });

  r.get('/sources/duplicates', async (c) =>
    c.json(await kn.get(`/duplicates?workspace_id=${enc(workspaceId)}`)),
  );

  r.post('/sources/merge', async (c) => {
    const req = await body(c, MergeSourcesRequest);
    return c.json(await kn.post('/sources/merge', req));
  });

  r.post('/sources/duplicates/dismiss', async (c) => {
    const req = await body(c, DismissDuplicateRequest);
    return c.json(await kn.post('/duplicates/dismiss', req));
  });

  r.get('/sources/:id', async (c) => c.json(await kn.get<Source>(`/sources/${enc(c.req.param('id'))}`)));

  r.patch('/sources/:id', async (c) => {
    const req = await body(c, PatchSourceRequest);
    return c.json(await kn.patch<Source>(`/sources/${enc(c.req.param('id'))}`, req));
  });

  r.delete('/sources/:id', async (c) => {
    await kn.del(`/sources/${enc(c.req.param('id'))}`);
    return c.body(null, 204);
  });

  r.get('/sources/:id/content', async (c) =>
    c.json(await kn.get(`/sources/${enc(c.req.param('id'))}/content`)),
  );

  r.get('/sources/:id/file', async (c) => {
    const res = await kn.stream('GET', `/sources/${enc(c.req.param('id'))}/file`, {
      signal: c.req.raw.signal,
    });
    const headers = new Headers();
    for (const h of ['content-type', 'content-length', 'content-disposition', 'last-modified', 'etag'])
      if (res.headers.get(h)) headers.set(h, res.headers.get(h) as string);
    // An original file is shown, never run: no sniffing, no scripts.
    headers.set('x-content-type-options', 'nosniff');
    headers.set(
      'content-security-policy',
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    );
    return new Response(res.body, { status: 200, headers });
  });

  r.post('/sources/:id/retry', async (c) =>
    c.json(await kn.post(`/sources/${enc(c.req.param('id'))}/retry`)),
  );
  r.post('/sources/:id/refetch', async (c) =>
    c.json(await kn.post(`/sources/${enc(c.req.param('id'))}/refetch`)),
  );

  /* ---- Search ----------------------------------------------------------- */

  r.post('/search', async (c) => {
    const req = await body(c, SearchRequest);
    if (req.notebook_id) await notebook(req.notebook_id);
    return c.json(await kn.post('/search', { ...req, workspace_id: workspaceId }));
  });

  return r;
}
