/**
 * ------------------------------------------------------------------
 *  Title    |  Bulk thread actions, Trash and read state
 *  Ref      |  ROADMAP TC3, TC4, RA1 · guard rail GR23
 *  ID       |  core/test
 * ------------------------------------------------------------------
 *  Purpose  |  Many threads move, archive and delete in one call and
 *           |  Undo puts every one back exactly (notebook, pins and
 *           |  place in the list). A thread being answered is left
 *           |  and named. Deleted threads wait 30 days in the Trash,
 *           |  restore whole, and the purge removes them only after
 *           |  that and never during a run. Emptying the Trash needs
 *           |  the confirm. The rail's unread and needs-you flags.
 * ------------------------------------------------------------------
 */

import { type ThreadBulkResult, type ThreadSummary, TRASH_DAYS, type TrashItem } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { bulkThreads, emptyTrash, purgeExpired, scheduleTrashPurge } from '../../src/threads/bulk';
import { harness, WORKSPACE_ID } from '../support/harness';

type H = Awaited<ReturnType<typeof harness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const DAY = 86_400_000;

async function threads(hh: H, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await hh.newThread({ title: `Thread ${i}` }));
  return ids;
}
const list = async (hh: H, q = '') =>
  (await hh.call<{ items: ThreadSummary[] }>('GET', `/threads${q}`)).body.items;
const bulk = (hh: H, body: unknown) => hh.call<ThreadBulkResult>('POST', '/threads/bulk', body);

describe('POST /threads/bulk', () => {
  it('moves threads into a notebook, names the count, and Undo restores exactly', async () => {
    h = await harness();
    const [a, b, c] = (await threads(h, 3)) as string[] as [string, string, string];
    await h.call('PATCH', `/threads/${b}`, { pinned: true });
    const before = await list(h);

    const r = await bulk(h, { action: 'move', ids: [a, b], notebook_id: 'nbk_one' });
    expect(r.status).toBe(200);
    expect(r.body.done.map((s) => s.id).sort()).toEqual([a, b].sort());
    expect(r.body.skipped).toEqual([]);
    const moved = await list(h);
    expect(moved.find((t) => t.id === a)?.notebook_id).toBe('nbk_one');
    expect(moved.find((t) => t.id === c)?.notebook_id).toBeNull();
    // A move never reorders the rail.
    expect(moved.map((t) => t.id)).toEqual(before.map((t) => t.id));

    const undo = await bulk(h, { action: 'revert', states: r.body.done });
    expect(undo.body.done).toHaveLength(2);
    expect(await list(h)).toEqual(before);
  });

  it('archives and unarchives, keeping pins and order across Undo', async () => {
    h = await harness();
    const [a, b] = (await threads(h, 2)) as string[] as [string, string];
    await h.call('PATCH', `/threads/${a}`, { pinned: true });
    const before = await list(h);
    const r = await bulk(h, { action: 'archive', ids: [a, b] });
    expect(r.body.done).toHaveLength(2);
    expect(await list(h)).toEqual([]);
    expect((await list(h, '?archived=1')).map((t) => t.id).sort()).toEqual([a, b].sort());
    await bulk(h, { action: 'revert', states: r.body.done });
    expect(await list(h)).toEqual(before);
    expect((await list(h)).find((t) => t.id === a)?.pinned_at).not.toBeNull();
  });

  it('leaves a thread that is being answered, and says which', async () => {
    h = await harness();
    const [a, b] = (await threads(h, 2)) as string[] as [string, string];
    h.worker.stop();
    await h.runs.create({
      id: 'run_busy',
      kind: 'chat_turn',
      traceId: '0'.repeat(32),
      threadId: b,
      messageId: null,
      checkpoint: {},
    });
    const r = await bulk(h, { action: 'delete', ids: [a, b] });
    expect(r.body.done.map((s) => s.id)).toEqual([a]);
    expect(r.body.skipped).toEqual([
      expect.objectContaining({ id: b, title: 'Thread 1', reason: 'running' }),
    ]);
    expect((await list(h)).map((t) => t.id)).toEqual([b]);
  });

  it('skips a missing thread and still does the rest', async () => {
    h = await harness();
    const [a] = (await threads(h, 1)) as string[] as [string];
    const r = await bulk(h, { action: 'archive', ids: ['thr_nope', a] });
    expect(r.body.done.map((s) => s.id)).toEqual([a]);
    expect(r.body.skipped[0]).toMatchObject({ id: 'thr_nope', reason: 'missing' });
  });

  it('refuses an unknown notebook and rejects an empty or oversized list', async () => {
    h = await harness();
    const [a] = (await threads(h, 1)) as string[] as [string];
    expect((await bulk(h, { action: 'move', ids: [], notebook_id: null })).status).toBe(400);
    expect((await bulk(h, { action: 'nope', ids: [a] })).status).toBe(400);
    expect(
      (
        await bulk(h, {
          action: 'move',
          ids: Array.from({ length: 501 }, (_, i) => `t${i}`),
          notebook_id: null,
        })
      ).status,
    ).toBe(400);
  });

  it('keeps Claude Code threads out of a private notebook and moves the rest', async () => {
    h = await harness();
    const plain = await h.newThread({ title: 'Plain' });
    const cc = await h.newThread({ title: 'From Claude Code' });
    await h.repo.patchThread(cc, { settings: { claude_code: { session_id: 's1', cwd: '/x' } } as never });
    const r = await bulkThreads(
      {
        repo: h.repo,
        runs: h.runs,
        workspaceId: WORKSPACE_ID,
        notebookExists: async () => true,
        notebookPrivate: async () => true,
      },
      { action: 'move', ids: [plain, cc], notebook_id: 'nbk_private' },
    );
    expect(r.done.map((s) => s.id)).toEqual([plain]);
    expect(r.skipped).toEqual([
      {
        id: cc,
        title: 'From Claude Code',
        reason: 'refused',
        hint: 'Claude Code threads stay out of private notebooks.',
      },
    ]);
  });
});

describe('the Trash', () => {
  it('holds a deleted thread, hides it everywhere else, and restores it whole', async () => {
    h = await harness();
    const [a, b] = (await threads(h, 2)) as string[] as [string, string];
    await h.call('PATCH', `/threads/${a}`, { pinned: true, notebook_id: 'nbk_one' });
    const before = await list(h);
    expect((await h.call('DELETE', `/threads/${a}`)).status).toBe(204);

    expect((await h.call('GET', `/threads/${a}`)).status).toBe(404);
    expect((await list(h)).map((t) => t.id)).toEqual([b]);
    const trash = await h.call<{ items: TrashItem[]; retention_days: number }>('GET', '/threads/trash');
    expect(trash.body.retention_days).toBe(TRASH_DAYS);
    expect(trash.body.items.map((t) => t.id)).toEqual([a]);
    const item = trash.body.items[0] as TrashItem;
    expect(Date.parse(item.purge_at) - Date.parse(item.deleted_at)).toBe(TRASH_DAYS * DAY);

    const back = await bulk(h, { action: 'restore', ids: [a] });
    expect(back.body.done.map((s) => s.id)).toEqual([a]);
    expect(await list(h)).toEqual(before);
    expect((await h.call<{ items: TrashItem[] }>('GET', '/threads/trash')).body.items).toEqual([]);
  });

  it('delete through the bulk route can be undone, and does not touch a thread twice', async () => {
    h = await harness();
    const [a] = (await threads(h, 1)) as string[] as [string];
    const r = await bulk(h, { action: 'delete', ids: [a, a] });
    expect(r.body.done).toHaveLength(1);
    const again = await bulk(h, { action: 'archive', ids: [a] });
    expect(again.body.skipped[0]).toMatchObject({ id: a, reason: 'missing' });
    await bulk(h, { action: 'revert', states: r.body.done });
    expect((await list(h)).map((t) => t.id)).toEqual([a]);
  });

  it('purges only after 30 days, by the clock, and never while a run is active', async () => {
    h = await harness();
    const [a, b] = (await threads(h, 2)) as string[] as [string, string];
    await h.call('DELETE', `/threads/${a}`);
    const t0 = Date.parse((await h.repo.listTrash(WORKSPACE_ID))[0]?.deleted_at as string);
    await h.call('DELETE', `/threads/${b}`);
    const swept: string[] = [];
    const deps = {
      repo: h.repo,
      runs: h.runs,
      workspaceId: WORKSPACE_ID,
      afterPurge: async (id: string) => void swept.push(id),
    };

    expect(await purgeExpired({ ...deps, now: () => new Date(t0 + 29 * DAY) })).toBe(0);
    expect(await h.repo.listTrash(WORKSPACE_ID)).toHaveLength(2);

    // A run elsewhere in the workspace holds the purge off.
    h.worker.stop();
    const other = await h.newThread({ title: 'Busy' });
    await h.runs.create({
      id: 'run_other',
      kind: 'chat_turn',
      traceId: '0'.repeat(32),
      threadId: other,
      messageId: null,
      checkpoint: {},
    });
    expect(await purgeExpired({ ...deps, now: () => new Date(t0 + 31 * DAY) })).toBeNull();
    expect(await h.repo.listTrash(WORKSPACE_ID)).toHaveLength(2);

    const run = h.runs.runs.get('run_other');
    if (run) run.status = 'succeeded' as never;
    expect(await purgeExpired({ ...deps, now: () => new Date(t0 + 31 * DAY) })).toBe(2);
    expect(await h.repo.listTrash(WORKSPACE_ID)).toEqual([]);
    expect(swept.sort()).toEqual([a, b].sort());
    expect(h.repo.threads.has(a)).toBe(false);
  });

  it('the daily schedule runs, repeats and stops', async () => {
    h = await harness();
    const [a] = (await threads(h, 1)) as string[] as [string];
    await h.call('DELETE', `/threads/${a}`);
    let at = Date.now() + 40 * DAY;
    const stop = scheduleTrashPurge(
      { repo: h.repo, runs: h.runs, workspaceId: WORKSPACE_ID, now: () => new Date(at) },
      { firstMs: 5, everyMs: 20 },
    );
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(await h.repo.listTrash(WORKSPACE_ID)).toEqual([]);
    at += DAY;
  });

  it('Empty Trash needs the confirm, then removes everything in it', async () => {
    h = await harness();
    const [a, b, c] = (await threads(h, 3)) as string[] as [string, string, string];
    await bulk(h, { action: 'delete', ids: [a, b] });

    const no = await h.call<{ error: { code: string } }>('POST', '/threads/trash/empty', { confirm: false });
    expect(no.status).toBe(400);
    expect(no.body.error.code).toBe('trash.confirm_needed');
    expect(await h.repo.listTrash(WORKSPACE_ID)).toHaveLength(2);

    const yes = await h.call<{ purged: number; kept: number }>('POST', '/threads/trash/empty', {
      confirm: true,
    });
    expect(yes.body).toEqual({ purged: 2, kept: 0 });
    expect((await list(h)).map((t) => t.id)).toEqual([c]);
    expect(await emptyTrash({ repo: h.repo, runs: h.runs, workspaceId: WORKSPACE_ID }, true)).toEqual({
      purged: 0,
      kept: 0,
    });
  });
});

describe('read state in the thread list', () => {
  it('flags an answer you have not opened, clears it when seen, and flags a run waiting on you', async () => {
    h = await harness();
    const [a] = (await threads(h, 1)) as string[] as [string];
    expect((await list(h))[0]).toMatchObject({ unread: false, waiting: false });

    await h.repo.insertMessage({
      id: 'm_user',
      thread_id: a,
      parent_id: null,
      role: 'user',
      parts: [{ type: 'text', text: 'hi' }],
      status: 'complete',
      trace_id: '0'.repeat(32),
    });
    await h.repo.insertMessage({
      id: 'm_ans',
      thread_id: a,
      parent_id: 'm_user',
      role: 'assistant',
      parts: [{ type: 'text', text: 'hello' }],
      status: 'complete',
      trace_id: '0'.repeat(32),
    });
    expect((await list(h))[0]?.unread).toBe(true);
    expect((await h.call('POST', `/threads/${a}/seen`)).status).toBe(204);
    expect((await list(h))[0]?.unread).toBe(false);

    h.repo.waitingThreads.add(a);
    h.repo.liveThreads.add(a);
    expect((await list(h))[0]).toMatchObject({ live: true, waiting: true });
  });
});
