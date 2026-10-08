/**
 * ------------------------------------------------------------------
 *  Title    |  Diagnostic routes and record
 *  Ref      |  ROADMAP Phase 5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Start a self-diagnostic, follow it live, read old runs.
 * ------------------------------------------------------------------
 */

import type { DiagnosticRun } from '@nvx/contracts';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import type { AppEnv } from '../app';
import { lastEventId, sseStream } from '../http/sse';
import { notFound } from '../obs/errors';
import type { DiagnosticEvent, DiagnosticRunner, DiagnosticStore } from './runner';

export function diagnosticRoutes(deps: { runner: DiagnosticRunner }) {
  const r = new Hono<AppEnv>();

  r.post('/system/diagnostics', (c) => c.json(deps.runner.start(), 202));

  r.get('/system/diagnostics', async (c) =>
    c.json({ items: await deps.runner.recent(10), next_cursor: null }),
  );

  r.get('/system/diagnostics/:id', async (c) => {
    const id = c.req.param('id');
    const run = deps.runner.get(id) ?? (await deps.runner.recent(50)).find((x) => x.id === id);
    if (!run) throw notFound('That diagnostic run');
    return c.json(run);
  });

  r.get('/system/diagnostics/:id/stream', (c) => {
    const id = c.req.param('id');
    if (!deps.runner.get(id)) throw notFound('That diagnostic run');
    return sseStream<DiagnosticEvent>(
      c,
      (emit) => deps.runner.subscribe(id, lastEventId(c), emit) ?? (() => undefined),
    );
  });

  return r;
}

export class PgDiagnosticStore implements DiagnosticStore {
  constructor(private readonly sql: Sql) {}

  async save(run: DiagnosticRun) {
    await this.sql`
      insert into core.diagnostics (id, status, results, started_at, finished_at)
      values (${run.id}, ${run.status}, ${this.sql.json(run.checks as never)}, ${run.started_at}, ${run.finished_at})
      on conflict (id) do update set status = excluded.status, results = excluded.results,
        finished_at = excluded.finished_at`;
  }

  async recent(limit: number) {
    const rows = await this.sql<
      {
        id: string;
        status: DiagnosticRun['status'];
        results: DiagnosticRun['checks'];
        started_at: Date;
        finished_at: Date | null;
      }[]
    >`select * from core.diagnostics order by started_at desc limit ${limit}`;
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      started_at: r.started_at.toISOString(),
      finished_at: r.finished_at?.toISOString() ?? null,
      checks: r.results,
    }));
  }
}
