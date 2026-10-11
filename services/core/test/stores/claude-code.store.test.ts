/**
 * Claude Code bindings and bulk message inserts: the same behaviour from
 * the memory store and the Postgres one.
 */
import { beforeEach, expect, it } from 'vitest';
import { type ClaudeCodeStore, MemoryClaudeCodeStore, PgClaudeCodeStore } from '../../src/claudecode/store';
import { MemoryNotebookRepo, type NotebookRepo, PgNotebookRepo } from '../../src/notebooks/repo';
import { MemoryThreadRepo, PgThreadRepo, type ThreadRepo } from '../../src/threads/repo';
import { eachBackend, uid } from '../support/stores';

eachBackend('Claude Code store', (backend) => {
  let threads: ThreadRepo;
  let notebooks: NotebookRepo;
  let store: ClaudeCodeStore;
  let ws: string;

  beforeEach(() => {
    const b = backend();
    ws = b.owner.workspaceId;
    threads = b.sql ? new PgThreadRepo(b.sql) : new MemoryThreadRepo();
    notebooks = b.sql ? new PgNotebookRepo(b.sql) : new MemoryNotebookRepo();
    store = b.sql
      ? new PgClaudeCodeStore(b.sql, 'win32')
      : new MemoryClaudeCodeStore(threads as MemoryThreadRepo, 'win32');
  });

  it('inserts a message tree in one go, keeping time, usage and provenance, and reads the mirror back', async () => {
    const t = await threads.createThread({ id: uid('thr'), workspace_id: ws, title: 'From Claude Code' });
    const a = uid('msg');
    const b = uid('msg');
    const c = uid('msg');
    const base = { thread_id: t.id, status: 'complete' as const, trace_id: '0'.repeat(32) };
    await threads.insertMessages([
      {
        ...base,
        id: a,
        parent_id: null,
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
        created_at: '2026-10-01T09:00:00.000Z',
        provenance: { claude_code: { session_id: 's', uuid: 'u1', uuids: ['u1'] } },
      },
      {
        ...base,
        id: b,
        parent_id: a,
        role: 'assistant',
        parts: [{ type: 'text', text: 'hello' }],
        model_id: 'claude-code/claude-opus-5-5',
        usage: { input_tokens: 1, output_tokens: 2, cached_tokens: 3, cost_usd: 0 },
        created_at: '2026-10-01T09:00:01.000Z',
        provenance: { claude_code: { session_id: 's', uuid: 'a2', uuids: ['a1', 'a2'], last_api_id: 'm1' } },
      },
      {
        ...base,
        id: c,
        parent_id: b,
        role: 'user',
        parts: [{ type: 'text', text: 'more' }],
        created_at: '2026-10-01T09:00:02.000Z',
        provenance: { claude_code: { session_id: 's', uuid: 'u2', uuids: ['u2'] } },
      },
    ]);
    const msgs = await threads.messages(t.id);
    expect(msgs.map((m) => m.id)).toEqual([a, b, c]);
    expect(msgs[1]).toMatchObject({
      usage: { input_tokens: 1, output_tokens: 2, cached_tokens: 3 },
      created_at: '2026-10-01T09:00:01.000Z',
    });
    const mirror = await store.mirror(t.id);
    expect(mirror.byUuid.get('a1')).toBe(b);
    expect(mirror.messages.get(b)).toEqual({
      role: 'assistant',
      lastUuid: 'a2',
      hasChildren: true,
      lastApiId: 'm1',
    });
    expect(mirror.messages.get(c)?.hasChildren).toBe(false);
  });

  it('binds folders case-insensitively on Windows, and sessions to threads', async () => {
    const nb = await notebooks.create({ id: uid('nbk'), workspace_id: ws, title: 'cyberfolio' });
    await store.putProject(ws, 'C:\\Code\\cyberfolio', nb.id);
    await store.putProject(ws, 'c:/code/CYBERFOLIO/', nb.id);
    const mine = (await store.projects(ws)).filter((p) => p.notebook_id === nb.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.cwd).toBe('c:/code/CYBERFOLIO/');
    expect(await store.removeProject(ws, 'C:\\CODE\\cyberfolio')).toBe(true);

    const t = await threads.createThread({ id: uid('thr'), workspace_id: ws });
    const sid = uid('ses');
    await store.putSession(ws, {
      session_id: sid,
      thread_id: t.id,
      title: 'x',
      cwd: 'C:\\a',
      last_modified: 1_760_000_000_000,
      synced_at: '2026-10-01T09:00:00.000Z',
    });
    expect((await store.sessions(ws)).find((s) => s.session_id === sid)).toMatchObject({
      thread_id: t.id,
      last_modified: 1_760_000_000_000,
    });
    await threads.deleteThread(t.id);
    expect((await store.sessions(ws)).find((s) => s.session_id === sid)).toBeUndefined();
  });
});
