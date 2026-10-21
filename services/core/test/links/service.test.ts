/**
 * Context links (docs/notebooks.md): made from a thread or a notebook,
 * listed on both ends, refused at once when the scopes say no, and checked
 * again on every read, because a scope can change after the link was made.
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import { linkRoutes } from '../../src/links/routes';
import { LinkService, summariesBlock } from '../../src/links/service';
import { MemoryLinkStore } from '../../src/links/store';
import { threadSummary } from '../../src/links/summary';
import { errorHandler } from '../../src/obs/errors';
import { MemoryScopeStore, scopeResolver } from '../../src/scopes';
import { MemoryBranchStore } from '../../src/threads/branches';
import { MemoryThreadRepo } from '../../src/threads/repo';

const WS = 'wsp_01TESTWORKSPACE000000000000';

let scopes: MemoryScopeStore;
let store: MemoryLinkStore;
let links: LinkService;
const threads = new Map<string, { title: string; notebook_id: string | null; workspace_id: string }>();
const notebooks = new Map<string, { title: string; workspace_id: string }>();
const summaries = new Map<string, string>();

beforeEach(() => {
  scopes = new MemoryScopeStore();
  store = new MemoryLinkStore();
  threads.clear();
  notebooks.clear();
  summaries.clear();
  for (const [id, title] of [
    ['nbk_a', 'Alpha'],
    ['nbk_b', 'Bravo'],
    ['nbk_p', 'Private diary'],
  ] as const) {
    notebooks.set(id, { title, workspace_id: WS });
    scopes.notebooks.add(id);
  }
  notebooks.set('nbk_other_ws', { title: 'Elsewhere', workspace_id: 'wsp_other' });
  for (const [id, title, nb] of [
    ['thr_1', 'Pump question', 'nbk_a'],
    ['thr_2', 'Trial notes', 'nbk_b'],
    ['thr_loose', 'Loose thread', null],
  ] as const) {
    threads.set(id, { title, notebook_id: nb, workspace_id: WS });
    scopes.threads.set(id, nb);
  }
  summaries.set('thr_2', 'The trial ran for three weeks at 40 bar.');
  links = new LinkService({
    workspaceId: WS,
    store,
    scopes: scopeResolver(scopes),
    lookup: {
      thread: async (id) => threads.get(id) ?? null,
      notebook: async (id) => notebooks.get(id) ?? null,
    },
    summaryOf: async (id) => summaries.get(id) ?? null,
  });
});

describe('making links', () => {
  it('links a thread to a notebook and to another thread, listed on both ends', async () => {
    const toNb = await links.create({ kind: 'thread', id: 'thr_1' }, { to_kind: 'notebook', to_id: 'nbk_b' });
    expect(toNb).toMatchObject({
      kind: 'sources',
      from: { kind: 'thread', id: 'thr_1', title: 'Pump question' },
      to: { kind: 'notebook', id: 'nbk_b', title: 'Bravo' },
      status: { ok: true },
    });
    const toThread = await links.create(
      { kind: 'thread', id: 'thr_1' },
      { to_kind: 'thread', to_id: 'thr_2' },
    );
    expect(toThread.kind).toBe('summary');
    const mine = await links.list({ kind: 'thread', id: 'thr_1' });
    expect(mine.outgoing.map((l) => l.to.id)).toEqual(['nbk_b', 'thr_2']);
    expect(mine.incoming).toEqual([]);
    expect((await links.list({ kind: 'notebook', id: 'nbk_b' })).incoming.map((l) => l.from.id)).toEqual([
      'thr_1',
    ]);
    expect((await links.list({ kind: 'thread', id: 'thr_2' })).incoming).toHaveLength(1);
  });

  it('refuses itself, its own notebook, twice, and what is not there', async () => {
    await expect(
      links.create({ kind: 'notebook', id: 'nbk_a' }, { to_kind: 'notebook', to_id: 'nbk_a' }),
    ).rejects.toMatchObject({ code: 'link.self', status: 422 });
    await expect(
      links.create({ kind: 'thread', id: 'thr_1' }, { to_kind: 'notebook', to_id: 'nbk_a' }),
    ).rejects.toMatchObject({ code: 'link.own_notebook' });
    await links.create({ kind: 'notebook', id: 'nbk_a' }, { to_kind: 'notebook', to_id: 'nbk_b' });
    await expect(
      links.create({ kind: 'notebook', id: 'nbk_a' }, { to_kind: 'notebook', to_id: 'nbk_b' }),
    ).rejects.toMatchObject({ code: 'link.exists', status: 409 });
    await expect(
      links.create({ kind: 'thread', id: 'thr_1' }, { to_kind: 'notebook', to_id: 'nbk_other_ws' }),
    ).rejects.toMatchObject({ code: 'request.not_found' });
    await expect(
      links.create({ kind: 'thread', id: 'thr_nope' }, { to_kind: 'notebook', to_id: 'nbk_b' }),
    ).rejects.toMatchObject({ code: 'request.not_found' });
  });

  it('refuses a private notebook linked into a thread whose answers may go to the cloud', async () => {
    await scopes.setPrivate('nbk_p', true);
    await expect(
      links.create({ kind: 'thread', id: 'thr_1' }, { to_kind: 'notebook', to_id: 'nbk_p' }),
    ).rejects.toMatchObject({ code: 'scope.private_notebook', status: 403 });
    // A thread kept on this machine may read it.
    await scopes.mergePatch('thread', 'thr_1', { data_leaves_machine: false });
    const ok = await links.create({ kind: 'thread', id: 'thr_1' }, { to_kind: 'notebook', to_id: 'nbk_p' });
    expect(ok.status).toEqual({ ok: true });
  });

  it('removes a link, only in this workspace', async () => {
    const l = await links.create({ kind: 'thread', id: 'thr_1' }, { to_kind: 'notebook', to_id: 'nbk_b' });
    await links.remove(l.id);
    await expect(links.remove(l.id)).rejects.toMatchObject({ code: 'request.not_found' });
    await expect(links.list({ kind: 'notebook', id: 'nbk_other_ws' })).rejects.toMatchObject({
      code: 'request.not_found',
    });
  });
});

describe('reading through links in a turn', () => {
  it('gives linked notebooks and summaries, the thread’s own link first', async () => {
    await links.create({ kind: 'notebook', id: 'nbk_a' }, { to_kind: 'notebook', to_id: 'nbk_b' });
    await links.create({ kind: 'thread', id: 'thr_1' }, { to_kind: 'notebook', to_id: 'nbk_b' });
    await links.create({ kind: 'notebook', id: 'nbk_a' }, { to_kind: 'thread', to_id: 'thr_2' });
    const t = await links.forTurn('thr_1');
    expect(t.notebooks).toHaveLength(1);
    expect(t.notebooks[0]).toMatchObject({
      via: 'thread',
      notebookId: 'nbk_b',
      title: 'Bravo',
      sourceIds: undefined,
    });
    expect(t.summaries[0]).toMatchObject({ via: 'notebook', threadId: 'thr_2', title: 'Trial notes' });
    expect(summariesBlock(t.summaries)).toContain('Thread "Trial notes"');
    expect(summariesBlock([])).toBe('');
  });

  it('checks both scopes again on every read, and says why it refused', async () => {
    await links.create({ kind: 'thread', id: 'thr_1' }, { to_kind: 'notebook', to_id: 'nbk_b' });
    await links.create({ kind: 'thread', id: 'thr_1' }, { to_kind: 'thread', to_id: 'thr_2' });
    // B became private after the link was made.
    await scopes.setPrivate('nbk_b', true);
    let t = await links.forTurn('thr_1');
    expect(t.notebooks).toEqual([]);
    expect(t.summaries).toEqual([]);
    expect(t.skipped.map((s) => [s.to_id, s.state, s.code])).toEqual([
      ['nbk_b', 'refused', 'scope.private_notebook'],
      ['thr_2', 'refused', 'scope.private_notebook'],
    ]);
    // Listing says so too.
    const listed = await links.list({ kind: 'thread', id: 'thr_1' });
    expect(listed.outgoing[0]?.status).toMatchObject({ ok: false, code: 'scope.private_notebook' });
    // The reading thread turns links off.
    await scopes.setPrivate('nbk_b', false);
    await scopes.mergePatch('thread', 'thr_1', { context_links: false });
    t = await links.forTurn('thr_1');
    expect(t.skipped.every((s) => s.code === 'scope.context_links_off')).toBe(true);
  });

  it('refuses Claude Code as the reader of local-only data', async () => {
    await scopes.mergePatch('notebook', 'nbk_b', { data_leaves_machine: false });
    await scopes.mergePatch('thread', 'thr_1', { data_leaves_machine: false });
    await links.create({ kind: 'thread', id: 'thr_1' }, { to_kind: 'notebook', to_id: 'nbk_b' });
    expect((await links.forTurn('thr_1')).notebooks).toHaveLength(1);
    const cc = await links.forTurn('thr_1', { engine: 'claude_code', local: false });
    expect(cc.notebooks).toEqual([]);
    expect(cc.skipped[0]?.code).toBe('scope.data_stays_local');
  });

  it('passes on the linked notebook’s source limit, and skips one that allows none', async () => {
    await scopes.mergePatch('notebook', 'nbk_b', { sources: ['src_1'] });
    await links.create({ kind: 'thread', id: 'thr_loose' }, { to_kind: 'notebook', to_id: 'nbk_b' });
    expect((await links.forTurn('thr_loose')).notebooks[0]?.sourceIds).toEqual(['src_1']);
    await scopes.mergePatch('notebook', 'nbk_b', { sources: [] });
    const t = await links.forTurn('thr_loose');
    expect(t.notebooks).toEqual([]);
    expect(t.skipped[0]).toMatchObject({ state: 'empty' });
  });

  it('skips a thread with no summary, and links whose end is gone', async () => {
    summaries.clear();
    await links.create({ kind: 'thread', id: 'thr_1' }, { to_kind: 'thread', to_id: 'thr_2' });
    await links.create({ kind: 'thread', id: 'thr_1' }, { to_kind: 'notebook', to_id: 'nbk_b' });
    notebooks.delete('nbk_b');
    const t = await links.forTurn('thr_1');
    expect(t.skipped).toEqual([
      expect.objectContaining({ to_id: 'thr_2', state: 'empty' }),
      // A link whose far end was deleted is named, not dropped without a word.
      expect.objectContaining({ to_id: 'nbk_b', state: 'missing', code: null }),
    ]);
    expect(t.notebooks).toEqual([]);
    expect((await links.forTurn('thr_nope')).skipped).toEqual([]);
  });
});

describe('context packs in a turn (Pro hands them over; Core checks the scopes)', () => {
  it('gives an allowed pack and refuses one from a private or local-only place', async () => {
    await scopes.setPrivate('nbk_p', true);
    const svc = new LinkService({
      workspaceId: WS,
      store,
      scopes: scopeResolver(scopes),
      lookup: {
        thread: async (id) => threads.get(id) ?? null,
        notebook: async (id) => notebooks.get(id) ?? null,
      },
      summaryOf: async () => null,
      packs: async () => [
        {
          pack_id: 'cpk_ok',
          name: 'Pump basics',
          via: 'notebook',
          local_only: false,
          origins: [
            { kind: 'notebook', id: 'nbk_b' },
            { kind: 'notebook', id: 'nbk_gone' },
          ],
          text: 'Pumps need priming.',
          sources: [
            { notebook_id: 'nbk_b', notebook_title: 'Bravo', source_ids: ['src_1'] },
            { notebook_id: 'nbk_b', notebook_title: 'Bravo', source_ids: [] },
          ],
        },
        {
          pack_id: 'cpk_private',
          name: 'Diary bits',
          via: 'thread',
          local_only: false,
          origins: [{ kind: 'notebook', id: 'nbk_p' }],
          text: 'Secret.',
          sources: [],
        },
        {
          pack_id: 'cpk_local',
          name: 'Local only',
          via: 'thread',
          local_only: true,
          origins: [],
          text: 'Stays here.',
          sources: [],
        },
      ],
    });
    const t = await svc.forTurn('thr_1');
    expect(t.notebooks).toEqual([
      {
        linkId: 'cpk_ok',
        source: 'pack',
        via: 'notebook',
        notebookId: 'nbk_b',
        title: 'Bravo',
        sourceIds: ['src_1'],
      },
    ]);
    expect(t.summaries.map((x) => [x.linkId, x.source, x.title])).toEqual([
      ['cpk_ok', 'pack', 'Pump basics'],
    ]);
    expect(summariesBlock(t.summaries)).toContain('Context pack "Pump basics"');
    expect(t.skipped.map((x) => [x.link_id, x.kind, x.code])).toEqual([
      ['cpk_private', 'pack', 'scope.private_notebook'],
      ['cpk_local', 'pack', 'scope.data_stays_local'],
    ]);
  });
});

describe('routes', () => {
  it('serves both ends and refuses a widening link with the scope’s code', async () => {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.route('/', linkRoutes(links));
    const made = await app.request('/threads/thr_1/links', {
      method: 'POST',
      body: JSON.stringify({ to_kind: 'thread', to_id: 'thr_2' }),
    });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    const listed = (await (await app.request('/threads/thr_2/links')).json()) as { incoming: unknown[] };
    expect(listed.incoming).toHaveLength(1);
    await scopes.setPrivate('nbk_p', true);
    const refused = await app.request('/notebooks/nbk_a/links', {
      method: 'POST',
      body: JSON.stringify({ to_kind: 'notebook', to_id: 'nbk_p' }),
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('scope.private_notebook');
    expect((await app.request(`/context-links/${id}`, { method: 'DELETE' })).status).toBe(204);
  });
});

describe('a thread’s summary', () => {
  it('is the newest summary, else a digest of the latest turns', async () => {
    const repo = new MemoryThreadRepo();
    const branches = new MemoryBranchStore();
    const t = await repo.createThread({ id: 'thr_sum', workspace_id: WS, notebook_id: null, title: 'T' });
    const read = threadSummary({ threads: repo, branches });
    expect(await read(t.id)).toBeNull();
    const msg = (id: string, parent: string | null, role: 'user' | 'assistant', text: string) =>
      repo.insertMessage({
        id,
        thread_id: t.id,
        parent_id: parent,
        role,
        parts: [{ type: 'text', text }],
        status: 'complete',
        trace_id: '0'.repeat(32),
      });
    await msg('msg_1', null, 'user', 'How heavy is it?');
    await msg('msg_2', 'msg_1', 'assistant', 'It weighs 18 kg.');
    expect(await read(t.id)).toContain('Answered: It weighs 18 kg.');
    await branches.addSummary({
      id: 'sum_1',
      thread_id: t.id,
      upto_message_id: 'msg_2',
      kind: 'tldr',
      content: 'A pump that weighs 18 kg.',
      tokens: 8,
      model_id: 'fake/model',
    });
    expect(await read(t.id)).toBe('A pump that weighs 18 kg.');
    expect(await read('thr_missing')).toBeNull();
  });
});
