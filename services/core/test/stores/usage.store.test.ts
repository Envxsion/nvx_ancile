/**
 * The usage source: the same groups from memory and from Postgres (one
 * grouped query over messages, threads and runs).
 */
import { beforeEach, expect, it } from 'vitest';
import { MemoryRunStore, PgRunStore } from '../../src/runs/store';
import { MemoryThreadRepo, PgThreadRepo, type ThreadRepo } from '../../src/threads/repo';
import { MemoryUsageSource, PgUsageSource, spendUsd, type UsageSource } from '../../src/usage/report';
import { eachBackend, uid } from '../support/stores';

eachBackend('usage source', (backend) => {
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
      repo = mem;
      runs = memRuns;
      source = new MemoryUsageSource({
        messages: () => mem.msgs.values(),
        workspaceOf: (id) => mem.threads.get(id)?.workspace_id ?? null,
        runKind: (id) => memRuns.runs.get(id)?.kind ?? null,
        titleOf: (id) => mem.threads.get(id)?.title ?? null,
        threadDeleted: (id) => !!mem.threads.get(id)?.deleted_at,
      });
    }
  });

  it('groups answers by local day, engine and model', async () => {
    const thread = uid('thr');
    await repo.createThread({ id: thread, workspace_id: ws });
    const run = uid('run');
    await runs.create({
      id: run,
      kind: 'agent',
      threadId: null,
      messageId: null,
      checkpoint: {},
      traceId: 't',
    });
    // Far in the future so other suites' rows never fall in the range.
    const at = (iso: string) => iso.replace('2026', '2099');
    // insertMessages keeps a message's own time, usage and provenance on both backends (as an import
    // does); Postgres's insertMessage starts a message fresh, and the answer's usage arrives by update.
    const add = (o: { at: string; model?: string; run?: string; cc?: boolean; i: number; cost: number }) =>
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
          created_at: at(o.at),
          usage: { input_tokens: o.i, output_tokens: 1, cached_tokens: 2, cost_usd: o.cost },
          ...(o.cc && { provenance: { claude_code: { session_id: 's' } } }),
        },
      ]);
    await add({ at: '2026-10-11T23:30:00Z', model: 'openai/gpt-5', i: 10, cost: 0.5 });
    await add({ at: '2026-10-12T08:00:00Z', model: 'openai/gpt-5', i: 20, cost: 0.25 });
    await add({ at: '2026-10-12T09:00:00Z', model: 'claude-code/opus', cc: true, i: 100, cost: 1 });
    await add({ at: '2026-10-12T10:00:00Z', run, i: 7, cost: 0 });
    // No usage: not counted.
    await repo.insertMessages([
      {
        id: uid('msg'),
        thread_id: thread,
        parent_id: null,
        role: 'assistant',
        parts: [],
        status: 'complete',
        trace_id: 't',
        created_at: at('2026-10-12T11:00:00Z'),
      },
    ]);

    const rows = await source.rows({
      workspaceId: ws,
      tz: 'Europe/London',
      bucket: 'day',
      from: new Date(at('2026-10-11T00:00:00Z')),
      to: new Date(at('2026-10-13T00:00:00Z')),
    });
    const sorted = rows
      // None of these answers came through OpenRouter, so none names a served provider.
      .map(({ provider, ...r }) => ({ ...r, ...(provider && { provider }) }))
      .sort((a, b) => `${a.bucket}${a.engine}`.localeCompare(`${b.bucket}${b.engine}`));
    expect(sorted).toEqual([
      {
        bucket: '2099-10-12',
        engine: 'claude_code',
        model_id: 'claude-code/opus',
        input_tokens: 100,
        output_tokens: 1,
        cached_tokens: 2,
        cost_usd: 1,
        estimated_usd: 1,
        answers: 1,
      },
      {
        bucket: '2099-10-12',
        engine: 'gateway',
        model_id: 'openai/gpt-5',
        input_tokens: 30,
        output_tokens: 2,
        cached_tokens: 4,
        cost_usd: 0.75,
        estimated_usd: 0,
        answers: 2,
      },
      {
        bucket: '2099-10-12',
        engine: 'lab',
        model_id: null,
        input_tokens: 7,
        output_tokens: 1,
        cached_tokens: 2,
        cost_usd: 0,
        estimated_usd: 0,
        answers: 1,
      },
    ]);
  });

  it("counts Claude Code as a model as Claude Code, and adds up Claude Code's week by thread", async () => {
    const busy = uid('thr');
    const quiet = uid('thr');
    await repo.createThread({ id: busy, workspace_id: ws, title: 'Refactor the parser' });
    await repo.createThread({ id: quiet, workspace_id: ws, title: 'Quick question' });
    const at = (iso: string) => iso.replace('2026', '2098');
    const add = (thread: string, o: { at: string; model: string; cc?: boolean; i: number; c: number }) =>
      repo.insertMessages([
        {
          id: uid('msg'),
          thread_id: thread,
          parent_id: null,
          role: 'assistant',
          parts: [{ type: 'text', text: 'ok' }],
          status: 'complete',
          model_id: o.model,
          run_id: null,
          trace_id: 't',
          created_at: at(o.at),
          usage: { input_tokens: o.i, output_tokens: 5, cached_tokens: o.c, cost_usd: 0 },
          ...(o.cc && { provenance: { claude_code: { session_id: 's' } } }),
        },
      ]);
    await add(busy, { at: '2026-10-12T09:00:00Z', model: 'claude-sonnet', cc: true, i: 100, c: 300 });
    await add(busy, { at: '2026-10-12T10:00:00Z', model: 'claude-sonnet', cc: true, i: 50, c: 150 });
    // Claude Code as a model (Mode A): no session provenance, only its model id.
    await add(quiet, { at: '2026-10-12T11:00:00Z', model: 'claude-code/haiku', i: 10, c: 0 });
    await add(quiet, { at: '2026-10-12T12:00:00Z', model: 'openai/gpt-5', i: 999, c: 0 });
    const q = {
      workspaceId: ws,
      tz: 'UTC',
      bucket: 'day' as const,
      from: new Date(at('2026-10-12T00:00:00Z')),
      to: new Date(at('2026-10-13T00:00:00Z')),
    };
    const engines = (await source.rows(q)).map((r) => [r.model_id, r.engine]);
    expect(engines).toContainEqual(['claude-code/haiku', 'claude_code']);
    expect(engines).toContainEqual(['openai/gpt-5', 'gateway']);
    const threads = await source.claudeCodeThreads?.(q, 8);
    expect(threads?.map((t) => [t.title, t.input_tokens, t.cached_tokens, t.answers])).toEqual([
      ['Refactor the parser', 150, 450, 2],
      ['Quick question', 10, 0, 1],
    ]);
  });

  it('counts a Claude Code answer once, where it lives now, and adds up what was imported', async () => {
    const here = uid('thr');
    const gone = uid('thr');
    await repo.createThread({ id: here, workspace_id: ws });
    await repo.createThread({ id: gone, workspace_id: ws });
    const run = uid('run');
    await runs.create({
      id: run,
      kind: 'claude_code',
      threadId: here,
      messageId: null,
      checkpoint: {},
      traceId: 't',
    });
    const at = (iso: string) => iso.replace('2026', '2097');
    const add = async (
      thread: string,
      o: { i: number; model?: string; cc?: Record<string, unknown>; run?: string; cost?: number },
    ) => {
      const id = uid('msg');
      await repo.insertMessages([
        {
          id,
          thread_id: thread,
          parent_id: null,
          role: 'assistant',
          parts: [{ type: 'text', text: 'ok' }],
          status: 'complete',
          model_id: o.model ?? 'claude-sonnet',
          run_id: o.run ?? null,
          trace_id: 't',
          created_at: at('2026-10-12T09:00:00Z'),
          usage: { input_tokens: o.i, output_tokens: 0, cached_tokens: 0, cost_usd: o.cost ?? 0 },
          ...(o.cc && { provenance: { claude_code: o.cc } }),
        },
      ]);
      return id;
    };
    await add(here, { i: 100, cc: { session_id: 'term_a' } });
    await add(here, { i: 200, cc: { session_id: 'term_b' } });
    await add(here, { i: 400, cc: { session_id: 'live', live: true } });
    // A live turn written before the live mark: its run tells it apart.
    await add(here, { i: 800, cc: { session_id: 'live' }, run });
    // A copy a sync replaced, and a copy in a thread deleted after import: not counted again.
    await repo.discardMessages([await add(here, { i: 1600, cc: { session_id: 'term_a' } })]);
    await add(gone, { i: 3200, cc: { session_id: 'term_c' } });
    await repo.deleteThread(gone);
    // A deleted gateway answer still cost money.
    await repo.discardMessages([await add(here, { i: 6400, model: 'openai/gpt-5', cost: 2 })]);

    const q = {
      workspaceId: ws,
      tz: 'UTC',
      bucket: 'day' as const,
      from: new Date(at('2026-10-12T00:00:00Z')),
      to: new Date(at('2026-10-13T00:00:00Z')),
    };
    const byEngine = new Map<string, number>();
    for (const r of await source.rows(q))
      byEngine.set(r.engine, (byEngine.get(r.engine) ?? 0) + r.input_tokens);
    expect(Object.fromEntries(byEngine)).toEqual({ claude_code: 1500, gateway: 6400 });
    expect((await source.claudeCodeThreads?.(q, 8))?.map((t) => [t.thread_id, t.input_tokens])).toEqual([
      [here, 1500],
    ]);
    // A flow's month_spend_usd counts what bills: the deleted gateway answer, never Claude Code.
    if (sql) {
      // Only this test's answers sit at that instant; later suites' rows are in both sums.
      const fromHere = await spendUsd(sql, q.from);
      expect(fromHere - (await spendUsd(sql, new Date(at('2026-10-12T09:00:01Z'))))).toBeCloseTo(2);
    }
    expect(await source.claudeCodeImported?.(q)).toEqual({
      input_tokens: 300,
      output_tokens: 0,
      cached_tokens: 0,
      cost_usd: 0,
      answers: 2,
      sessions: 2,
    });
  });
});
