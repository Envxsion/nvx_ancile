/**
 * Threads, messages and notebooks: the same behaviour from the in-memory
 * repositories the harness uses and the Postgres ones Core runs on.
 */
import { beforeEach, expect, it } from 'vitest';
import { MemoryNotebookRepo, type NotebookRepo, PgNotebookRepo } from '../../src/notebooks/repo';
import { MemoryThreadRepo, PgThreadRepo, type ThreadRepo } from '../../src/threads/repo';
import { eachBackend, uid } from '../support/stores';

eachBackend('thread and notebook repositories', (backend) => {
  let threads: ThreadRepo;
  let notebooks: NotebookRepo;
  let ws: string;

  beforeEach(() => {
    const b = backend();
    ws = b.owner.workspaceId;
    threads = b.sql ? new PgThreadRepo(b.sql) : new MemoryThreadRepo();
    notebooks = b.sql ? new PgNotebookRepo(b.sql) : new MemoryNotebookRepo();
  });

  const message = (
    thread_id: string,
    parent_id: string | null,
    role: 'user' | 'assistant',
    text: string,
  ) => ({
    id: uid('msg'),
    thread_id,
    parent_id,
    role,
    parts: [{ type: 'text' as const, text }],
    status: 'complete' as const,
    trace_id: '0'.repeat(32),
  });

  it('creates, reads, patches and soft-deletes a thread', async () => {
    const id = uid('thr');
    const t = await threads.createThread({ id, workspace_id: ws, title: 'Plan the launch' });
    expect(t).toMatchObject({ id, title: 'Plan the launch', title_source: 'user', notebook_id: null });
    const auto = await threads.createThread({ id: uid('thr'), workspace_id: ws });
    expect(auto.title_source).toBe('auto');

    const pinned = await threads.patchThread(id, {
      pinned: true,
      title: 'Launch plan',
      title_source: 'user',
    });
    expect(pinned?.pinned_at).toBeTruthy();
    expect(pinned?.title).toBe('Launch plan');
    const archived = await threads.patchThread(id, { archived: true, pinned: false });
    expect(archived?.archived_at).toBeTruthy();
    expect(archived?.pinned_at).toBeNull();
    expect((await threads.getThread(id))?.archived_at).toBeTruthy();

    const settings = { model: 'offline/test', flow_id: 'off' as const };
    expect((await threads.patchThread(id, { settings }))?.settings).toMatchObject(settings);

    expect(await threads.deleteThread(id)).toBe(true);
    expect(await threads.getThread(id)).toBeUndefined();
    expect(await threads.deleteThread(id)).toBe(false);
    expect(await threads.patchThread(id, { title: 'x' })).toBeUndefined();
  });

  it('lists threads newest first, by notebook, archived apart, a page at a time', async () => {
    const nb = await notebooks.create({ id: uid('nbk'), workspace_id: ws, title: `Book ${uid('t')}` });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = uid('thr');
      ids.push(id);
      await threads.createThread({ id, workspace_id: ws, title: `In book ${i}`, notebook_id: nb.id });
    }
    await threads.patchThread(ids[0] as string, { archived: true });
    const inBook = await threads.listThreads(ws, { notebookId: nb.id });
    expect(inBook.map((t) => t.id).sort()).toEqual([ids[1], ids[2]].sort());
    const archived = await threads.listThreads(ws, { notebookId: nb.id, archived: true });
    expect(archived.map((t) => t.id)).toEqual([ids[0]]);

    const first = await threads.listThreads(ws, { notebookId: nb.id, limit: 1 });
    expect(first).toHaveLength(1);
    const last = first[0] as { updated_at: string; id: string };
    const next = await threads.listThreads(ws, {
      notebookId: nb.id,
      limit: 1,
      cursor: `${last.updated_at}|${last.id}`,
    });
    expect(next).toHaveLength(1);
    expect(next[0]?.id).not.toBe(last.id);

    const counts = await threads.countByNotebook(ws);
    // Archived threads still belong to the notebook.
    expect(counts.get(nb.id)).toBe(3);
  });

  it('stores a conversation tree, edits and soft-deletes messages, and finds them by text', async () => {
    const id = uid('thr');
    await threads.createThread({ id, workspace_id: ws, title: 'Heat pumps' });
    const word = `zebra${uid('w').toLowerCase()}`;
    const q = await threads.insertMessage(message(id, null, 'user', `Which heat pump suits a ${word}?`));
    const a = await threads.insertMessage(message(id, q.id, 'assistant', 'A 7 kW air source one.'));
    expect((await threads.messages(id)).map((m) => m.id)).toEqual([q.id, a.id]);

    await threads.updateMessage(a.id, {
      parts: [{ type: 'text', text: 'An 8 kW one.' }],
      status: 'complete',
      model_id: 'offline/test',
      usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_usd: 0 },
      provenance: { route: { kind: 'model', from: 'default' } },
    });
    const updated = await threads.getMessage(a.id);
    expect(updated?.parts).toEqual([{ type: 'text', text: 'An 8 kW one.' }]);
    expect(updated?.model_id).toBe('offline/test');

    const hits = await threads.searchMessages(ws, word, 5);
    expect(hits.map((h) => h.message_id)).toContain(q.id);

    await threads.discardMessages([a.id]);
    expect((await threads.messages(id)).map((m) => m.id)).toEqual([q.id]);
    await threads.restoreMessages([a.id]);
    expect((await threads.messages(id)).map((m) => m.id)).toEqual([q.id, a.id]);
  });

  it('keeps notebooks and their notes', async () => {
    const id = uid('nbk');
    const nb = await notebooks.create({ id, workspace_id: ws, title: `Tax year ${id}`, color: 'jade' });
    expect(nb).toMatchObject({ id, color: 'jade', grounded: false });
    expect((await notebooks.list(ws)).some((n) => n.id === id)).toBe(true);
    const patched = await notebooks.patch(id, {
      pinned: true,
      grounded: true,
      opened: true,
      description: 'Receipts',
    });
    expect(patched).toMatchObject({ grounded: true, description: 'Receipts' });
    expect(patched?.pinned_at).toBeTruthy();
    expect(patched?.last_opened_at).toBeTruthy();

    const note = await notebooks.createNote({
      id: uid('nte'),
      notebook_id: id,
      kind: 'human',
      title: 'Mileage',
      content_md: '45p a mile',
    });
    expect((await notebooks.notes(id)).map((n) => n.id)).toEqual([note.id]);
    expect((await notebooks.noteCounts(ws)).get(id)).toBe(1);
    expect(
      (await notebooks.patchNote(note.id, { pinned: true, content_md: '45p for 10,000 miles' }))?.content_md,
    ).toBe('45p for 10,000 miles');
    expect(await notebooks.removeNote(note.id)).toBe(true);
    expect(await notebooks.getNote(note.id)).toBeUndefined();

    expect(await notebooks.remove(id)).toBe(true);
    expect(await notebooks.get(id)).toBeUndefined();
    expect(await notebooks.patch(id, { title: 'gone' })).toBeUndefined();
  });
});
