/**
 * The engines store, in memory and on Postgres (CORE_TEST_DATABASE_URL):
 * which summary each Claude Code session has seen, and a notebook's
 * instructions and persona.
 */
import { expect, it } from 'vitest';
import { type EngineStore, MemoryEngineStore, PgEngineStore } from '../../src/engines/store';
import { eachBackend, uid } from '../support/stores';

eachBackend('engine store', (backend) => {
  async function setup(): Promise<{ store: EngineStore; threadId: string; notebookId: string; ws: string }> {
    const b = backend();
    const ws = b.owner.workspaceId;
    const threadId = uid('thr');
    const notebookId = uid('nbk');
    if (!b.sql) {
      const store = new MemoryEngineStore();
      store.known.add(notebookId);
      return { store, threadId, notebookId, ws };
    }
    await b.sql`insert into core.notebooks (id, workspace_id, title, slug, memory_path)
      values (${notebookId}, ${ws}, 'Engines', ${notebookId.toLowerCase()}, ${`PROJECTS/${notebookId}.md`})`;
    await b.sql`insert into core.threads (id, workspace_id, notebook_id) values (${threadId}, ${ws}, ${notebookId})`;
    return { store: new PgEngineStore(b.sql), threadId, notebookId, ws };
  }

  it('remembers the summary each session was given, per thread', async () => {
    const { store, threadId, ws } = await setup();
    const s1 = uid('sess');
    expect((await store.seenForThread(ws, threadId)).size).toBe(0);
    await store.markSeen(ws, s1, threadId, 'sum_1');
    await store.markSeen(ws, s1, threadId, 'sum_2');
    expect((await store.seenForThread(ws, threadId)).get(s1)).toBe('sum_2');
  });

  it("keeps a notebook's instructions and persona, field by field", async () => {
    const { store, notebookId } = await setup();
    expect(await store.notebookInstructions(notebookId)).toEqual({ instructions: '', persona: '' });
    await store.setNotebookInstructions(notebookId, { instructions: 'Cite sources.' });
    expect(await store.setNotebookInstructions(notebookId, { persona: 'An editor' })).toEqual({
      instructions: 'Cite sources.',
      persona: 'An editor',
    });
    expect(await store.notebookInstructions(uid('nbk'))).toBeNull();
  });

  it("remembers the notebook's sources a thread's session last saw", async () => {
    const { store, threadId, ws } = await setup();
    expect(await store.sourceMarks(ws, threadId)).toBeNull();
    await store.markSources(ws, threadId, { src_1: 'Spec', src_2: 'Notes' });
    await store.markSources(ws, threadId, { src_1: 'Spec' });
    expect(await store.sourceMarks(ws, threadId)).toEqual({ src_1: 'Spec' });
  });
});
