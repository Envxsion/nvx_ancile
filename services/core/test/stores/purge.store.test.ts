/**
 * The Trash purge, in memory and on Postgres (CORE_TEST_DATABASE_URL): a purged thread's content
 * goes, history that must outlive it stays, and past spend does not change in Usage or in the
 * month-to-date budget.
 */
import { beforeEach, expect, it } from 'vitest';
import { MemoryRunStore, PgRunStore } from '../../src/runs/store';
import { MemoryThreadRepo, PgThreadRepo, type ThreadRepo } from '../../src/threads/repo';
import { MemoryUsageSource, PgUsageSource, spendUsd, type UsageSource } from '../../src/usage/report';
import { eachBackend, uid } from '../support/stores';

eachBackend('thread purge', (backend) => {
  let repo: ThreadRepo;
  let source: UsageSource;
  let runs: MemoryRunStore | PgRunStore;
  let ws: string;
  let sql: import('postgres').Sql | null;

  beforeEach(() => {
    const b = backend();
    ws = b.owner.workspaceId;
    sql = b.sql ?? null;
    if (b.sql) {
      repo = new PgThreadRepo(b.sql);
      runs = new PgRunStore(b.sql);
      source = new PgUsageSource(b.sql);
    } else {
      const mem = new MemoryThreadRepo();
      const memRuns = new MemoryRunStore();
      mem.runKind = (id) => memRuns.runs.get(id)?.kind ?? null;
      repo = mem;
      runs = memRuns;
      source = new MemoryUsageSource({
        messages: () => mem.msgs.values(),
        workspaceOf: (id) => mem.threads.get(id)?.workspace_id ?? null,
        runKind: (id) => memRuns.runs.get(id)?.kind ?? null,
        titleOf: (id) => mem.threads.get(id)?.title ?? null,
        threadDeleted: (id) => !!mem.threads.get(id)?.deleted_at,
        archive: () => mem.usageArchive,
      });
    }
  });

  const answer = (
    thread: string,
    o: { at: string; model?: string; run?: string; cc?: boolean; i: number; cost: number },
  ) =>
    repo.insertMessages([
      {
        id: uid('msg'),
        thread_id: thread,
        parent_id: null,
        role: 'assistant',
        parts: [{ type: 'text', text: 'ok' }],
        status: 'complete',
        model_id: o.model ?? null,
        run_id: o.run ?? null,
        trace_id: 't',
        created_at: o.at,
        usage: { input_tokens: o.i, output_tokens: 3, cached_tokens: 2, cost_usd: o.cost },
        ...(o.cc && { provenance: { claude_code: { session_id: 's' } } }),
      },
    ]);

  it('keeps past spend in Usage and in the month budget when a thread is purged', async () => {
    // A year nothing else uses, so the sums below are this test's alone.
    const at = (iso: string) => iso.replace('2026', '2095');
    const gone = uid('thr');
    const stays = uid('thr');
    await repo.createThread({ id: gone, workspace_id: ws });
    await repo.createThread({ id: stays, workspace_id: ws });
    const lab = uid('run');
    await runs.create({
      id: lab,
      kind: 'agent',
      threadId: null,
      messageId: null,
      checkpoint: {},
      traceId: 't',
    });
    // Spread over two UTC days, half-hour and hour edges, so each zone below groups them differently.
    await answer(gone, { at: at('2026-10-11T23:50:00Z'), model: 'openai/gpt-5', i: 10, cost: 0.5 });
    await answer(gone, { at: at('2026-10-12T08:14:00Z'), model: 'openai/gpt-5', i: 20, cost: 0.25 });
    await answer(gone, { at: at('2026-10-12T08:44:00Z'), model: 'anthropic/x', i: 30, cost: 1.5 });
    await answer(gone, { at: at('2026-10-12T18:31:00Z'), run: lab, i: 7, cost: 0 });
    // Claude Code in a deleted thread is not counted, before or after (the session comes back).
    await answer(gone, {
      at: at('2026-10-12T09:00:00Z'),
      model: 'claude-code/opus',
      cc: true,
      i: 100,
      cost: 1,
    });
    await answer(stays, { at: at('2026-10-12T09:00:00Z'), model: 'openai/gpt-5', i: 40, cost: 2 });

    const range = {
      workspaceId: ws,
      from: new Date(at('2026-10-10T00:00:00Z')),
      to: new Date(at('2026-10-14T00:00:00Z')),
    };
    const totals = async () => {
      const out: Record<string, unknown> = {};
      for (const tz of ['UTC', 'Europe/London', 'Asia/Kolkata', 'Pacific/Auckland', 'America/St_Johns'])
        for (const bucket of ['day', 'hour'] as const) {
          const rows = await source.rows({ ...range, tz, bucket });
          out[`${tz}|${bucket}`] = rows
            .map(({ provider, ...r }) => ({ ...r, provider: provider ?? null }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        }
      return out;
    };

    expect(await repo.deleteThread(gone)).toBe(true);
    const before = await totals();
    const spendBefore = sql ? await spendUsd(sql, range.from) : null;
    // Sanity: the deleted thread's gateway and lab answers are counted today.
    const sum = (rows: unknown) =>
      (rows as { input_tokens: number }[]).reduce((n, r) => n + r.input_tokens, 0);
    expect(sum(before['UTC|day'])).toBe(10 + 20 + 30 + 7 + 40);

    expect(await repo.purge([gone, stays])).toEqual([gone]);

    expect(await totals()).toEqual(before);
    if (sql) expect(await spendUsd(sql, range.from)).toBeCloseTo(spendBefore as number, 6);
    expect(await repo.messages(gone)).toEqual([]);
    expect(await repo.getThread(gone)).toBeUndefined();
    expect((await repo.messages(stays)).length).toBe(1);
  });

  it('purges only deleted threads: a restored thread is left whole', async () => {
    const id = uid('thr');
    await repo.createThread({ id, workspace_id: ws });
    await answer(id, { at: '2096-10-12T08:00:00Z', model: 'openai/gpt-5', i: 1, cost: 0 });
    await repo.deleteThread(id);
    expect(await repo.setFields(ws, id, { deleted_at: null })).toBe(true);
    expect(await repo.purge([id])).toEqual([]);
    expect((await repo.messages(id)).length).toBe(1);
    expect(await repo.purge([])).toEqual([]);
  });

  it('never purges a thread that is being answered', async () => {
    const id = uid('thr');
    await repo.createThread({ id, workspace_id: ws });
    await answer(id, { at: '2096-10-12T08:00:00Z', model: 'openai/gpt-5', i: 1, cost: 0 });
    await repo.deleteThread(id);
    if (repo instanceof MemoryThreadRepo) repo.liveThreads.add(id);
    else
      await runs.create({
        id: uid('run'),
        kind: 'chat_turn',
        threadId: id,
        messageId: null,
        checkpoint: {},
        traceId: 't',
      });
    expect(await repo.purge([id])).toEqual([]);
    expect((await repo.messages(id)).length).toBe(1);
  });

  it('on Postgres: deletes content, keeps audit and detaches it from the thread', async () => {
    if (!sql) return;
    const id = uid('thr');
    await repo.createThread({ id, workspace_id: ws });
    await answer(id, { at: '2096-10-12T08:00:00Z', model: 'openai/gpt-5', i: 1, cost: 0 });
    const done = uid('run');
    const audited = uid('run');
    for (const r of [done, audited]) {
      await runs.create({
        id: r,
        kind: 'chat_turn',
        threadId: id,
        messageId: null,
        checkpoint: { x: 1 },
        traceId: 't',
      });
      await sql`update core.runs set status = 'succeeded' where id = ${r}`;
      await sql`insert into core.run_steps (id, run_id, seq, kind, idempotency_key, status)
        values (${uid('stp')}, ${r}, 0, 'model', ${uid('k')}, 'succeeded')`;
      await sql`insert into core.run_events (run_id, seq, type, data) values (${r}, 0, 'x', '{}'::jsonb)`;
    }
    const approval = uid('apr');
    await sql`insert into core.approvals (id, run_id, step_seq, principal, thread_id, tool, action, resource, tier, status)
      values (${approval}, ${audited}, 0, 'tool:x', ${id}, 'x', 'run', 'r', 'gated', 'approved')`;
    const image = uid('img');
    await sql`insert into core.images (id, thread_id, sha256, mime, bytes, source)
      values (${image}, ${id}, 'abc', 'image/png', 1, 'generated')`;
    await sql`insert into core.drafts (thread_id, parent_id, user_id, content) values (${id}, '', 'u', '{}'::jsonb)`;
    await repo.deleteThread(id);

    expect(await repo.purge([id])).toEqual([id]);

    const [kept] = await sql<
      { thread_id: string | null }[]
    >`select thread_id from core.approvals where id = ${approval}`;
    expect(kept).toEqual({ thread_id: null });
    const left = await sql<{ id: string; thread_id: string | null; checkpoint: unknown }[]>`
      select id, thread_id, checkpoint from core.runs where id in (${done}, ${audited})`;
    expect(left).toEqual([{ id: audited, thread_id: null, checkpoint: null }]);
    const [steps] = await sql<
      { n: number }[]
    >`select count(*)::int as n from core.run_steps where run_id in (${done}, ${audited})`;
    const [events] = await sql<
      { n: number }[]
    >`select count(*)::int as n from core.run_events where run_id in (${done}, ${audited})`;
    expect([steps?.n, events?.n]).toEqual([0, 0]);
    expect(await sql`select 1 from core.images where id = ${image}`).toHaveLength(0);
    expect(await sql`select 1 from core.drafts where thread_id = ${id}`).toHaveLength(0);
    expect(await sql`select 1 from core.threads where id = ${id}`).toHaveLength(0);
  });
});
