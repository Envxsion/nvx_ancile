/**
 * Track G stores, in memory and on Postgres: source tombstones, and the
 * fact-check before the newest one (the score kept beside a re-run).
 */
import { beforeEach, expect, it } from 'vitest';
import { type FactcheckStore, MemoryFactcheckStore, PgFactcheckStore } from '../../src/factcheck/store';
import { MemoryTombstoneStore, PgTombstoneStore, type TombstoneStore } from '../../src/knowledge/integrity';
import { MemoryThreadRepo, PgThreadRepo, type ThreadRepo } from '../../src/threads/repo';
import { eachBackend, uid } from '../support/stores';

eachBackend('source tombstones', (backend) => {
  let store: TombstoneStore;
  let ws: string;
  beforeEach(() => {
    const b = backend();
    ws = b.owner.workspaceId;
    store = b.sql ? new PgTombstoneStore(b.sql) : new MemoryTombstoneStore();
  });

  it('keeps a removed source’s name and date, per workspace', async () => {
    const a = uid('src');
    const b = uid('src');
    await store.record({
      source_id: a,
      workspace_id: ws,
      title: 'Pump manual',
      kind: 'file',
      reason: 'deleted',
      merged_into: null,
    });
    await store.record({
      source_id: b,
      workspace_id: ws,
      title: 'Old copy',
      kind: 'url',
      reason: 'merged',
      merged_into: a,
    });
    const got = await store.get(ws, [a, b, uid('src')]);
    expect(got.size).toBe(2);
    expect(got.get(a)).toMatchObject({
      title: 'Pump manual',
      kind: 'file',
      reason: 'deleted',
      merged_into: null,
    });
    expect(got.get(b)).toMatchObject({ reason: 'merged', merged_into: a });
    expect(Number.isNaN(Date.parse(got.get(a)?.deleted_at ?? ''))).toBe(false);
    expect((await store.get('wsp_someone_else', [a])).size).toBe(0);
    expect((await store.get(ws, [])).size).toBe(0);
  });

  it('recording again refreshes the row rather than failing', async () => {
    const a = uid('src');
    await store.record({
      source_id: a,
      workspace_id: ws,
      title: 'First',
      kind: null,
      reason: 'deleted',
      merged_into: null,
    });
    await store.record({
      source_id: a,
      workspace_id: ws,
      title: 'Second',
      kind: null,
      reason: 'deleted',
      merged_into: null,
    });
    expect((await store.get(ws, [a])).get(a)?.title).toBe('Second');
  });
});

eachBackend('fact-check history', (backend) => {
  let store: FactcheckStore;
  let repo: ThreadRepo;
  let ws: string;
  beforeEach(() => {
    const b = backend();
    ws = b.owner.workspaceId;
    store = b.sql ? new PgFactcheckStore(b.sql) : new MemoryFactcheckStore();
    repo = b.sql ? new PgThreadRepo(b.sql) : new MemoryThreadRepo();
  });

  it('finds the newest finished check before a given one', async () => {
    const thread = uid('thr');
    await repo.createThread({ id: thread, workspace_id: ws });
    const msg = uid('msg');
    await repo.insertMessage({
      id: msg,
      thread_id: thread,
      parent_id: null,
      role: 'assistant',
      parts: [],
      status: 'complete',
      trace_id: 't',
    });
    const scope = { notebook_id: null, web: false };
    const make = async (id: string) => store.create({ id, message_id: msg, run_id: uid('run'), scope });
    const pause = () => new Promise((r) => setTimeout(r, 5));

    const a = uid('fck');
    await make(a);
    await store.finish(a, { confidence: 0.9, verifier_model_id: 'v', claims: [] });
    await pause();
    const failed = uid('fck');
    await make(failed);
    await store.fail(failed, { code: 'x', title: 'x', hint: 'x' });
    await pause();
    const b = uid('fck');
    await make(b);
    await store.finish(b, { confidence: 0.4, verifier_model_id: 'v', claims: [] });
    await pause();
    const c = uid('fck');
    await make(c);

    // A failed check in between is skipped; the running one sees the last finished score.
    expect((await store.previousFor(msg, c))?.id).toBe(b);
    expect((await store.previousFor(msg, b))?.id).toBe(a);
    expect(await store.previousFor(msg, a)).toBeUndefined();
    expect(await store.previousFor(msg, uid('fck'))).toBeUndefined();
  });
});
