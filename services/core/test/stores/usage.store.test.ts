/**
 * The usage source: the same groups from memory and from Postgres (one
 * grouped query over messages, threads and runs).
 */
import { beforeEach, expect, it } from 'vitest';
import { MemoryRunStore, PgRunStore } from '../../src/runs/store';
import { MemoryThreadRepo, PgThreadRepo, type ThreadRepo } from '../../src/threads/repo';
import { MemoryUsageSource, PgUsageSource, type UsageSource } from '../../src/usage/report';
import { eachBackend, uid } from '../support/stores';

eachBackend('usage source', (backend) => {
  let repo: ThreadRepo;
  let source: UsageSource;
  let runs: MemoryRunStore | PgRunStore;
  let ws: string;

  beforeEach(() => {
    const b = backend();
    ws = b.owner.workspaceId;
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
      .map((r) => ({ ...r }))
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
});
