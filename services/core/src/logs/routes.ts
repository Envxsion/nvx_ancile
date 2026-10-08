/**
 * ------------------------------------------------------------------
 *  Title    |  Logs
 *  Ref      |  DESIGN.md §11.5 · ROADMAP Phase 5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Every service's log in one place: filter by level,
 *           |  service, component, trace, time and text; follow it
 *           |  live; take it away as JSON or CSV.
 *  How      |  GET /logs pages backwards by id. GET /logs/stream is SSE:
 *           |  each line's id is its event id, so a reconnect (with
 *           |  Last-Event-ID) resumes exactly after the last line seen.
 *           |  The other services' lines arrive through the internal
 *           |  ingest route (the dev runner forwards their stdout).
 * ------------------------------------------------------------------
 */

import { type LogLine, LogQuery } from '@nvx/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app';
import { body } from '../http/body';
import { lastEventId, sseStream } from '../http/sse';
import { badRequest } from '../obs/errors';
import { matches, type ObsPipeline, toNewLog } from '../obs/store';

const MAX_EXPORT = 50_000;

function queryOf(c: { req: { query(): Record<string, string> } }): LogQuery {
  const parsed = LogQuery.safeParse(c.req.query());
  if (!parsed.success)
    throw badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return parsed.data;
}

const CSV_COLUMNS = [
  'id',
  'at',
  'level',
  'service',
  'component',
  'trace_id',
  'span_id',
  'msg',
  'data',
] as const;

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  // Spreadsheet formula injection: a cell starting with = + - @ is read as a formula.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(lines: LogLine[]): string {
  const head = CSV_COLUMNS.join(',');
  return [head, ...lines.map((l) => CSV_COLUMNS.map((k) => csvCell(l[k])).join(','))].join('\r\n');
}

export function logRoutes(deps: { pipeline: ObsPipeline }) {
  const r = new Hono<AppEnv>();
  const store = deps.pipeline.store;

  r.get('/logs', async (c) => {
    const q = queryOf(c);
    const [items, facets] = await Promise.all([store.queryLogs(q), store.facets()]);
    const last = items.at(-1);
    return c.json({ items, next_cursor: items.length === q.limit && last ? String(last.id) : null, facets });
  });

  r.get('/logs/stream', (c) => {
    const q = queryOf(c);
    // A first connection starts from now; a reconnect gets what it missed.
    const resuming = c.req.header('last-event-id') !== undefined || c.req.query('after') !== undefined;
    const after = resuming ? lastEventId(c) : null;
    return sseStream<{ seq: number; type: 'log'; line: LogLine }>(c, async (emit) => {
      let cursor = after ?? 0;
      const send = (l: LogLine) => {
        if (l.id <= cursor || !matches(l, q)) return;
        cursor = l.id;
        emit({ seq: l.id, type: 'log', line: l });
      };
      // Subscribe first, then backfill, so nothing falls between the two.
      const off = deps.pipeline.subscribe((lines) => {
        for (const l of lines) send(l);
      });
      if (after !== null) for (const l of await store.logsAfter(after, q, 1_000)) send(l);
      return off;
    });
  });

  r.get('/logs/export', async (c) => {
    const q = queryOf(c);
    const format = c.req.query('format') === 'csv' ? 'csv' : 'json';
    const lines: LogLine[] = [];
    let before: number | undefined;
    while (lines.length < MAX_EXPORT) {
      const page = await store.queryLogs({ ...q, limit: 1000, ...(before !== undefined && { before }) });
      lines.push(...page);
      if (page.length < 1000) break;
      before = page.at(-1)?.id;
    }
    lines.reverse();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `nvx-ancile-logs-${stamp}.${format}`;
    c.header('content-disposition', `attachment; filename="${name}"`);
    if (format === 'csv') {
      c.header('content-type', 'text/csv; charset=utf-8');
      return c.body(toCsv(lines));
    }
    c.header('content-type', 'application/json; charset=utf-8');
    return c.body(JSON.stringify(lines, null, 1));
  });

  return r;
}

const Ingest = z.object({
  service: z.string().min(1).max(40),
  lines: z.array(z.record(z.string(), z.unknown())).max(2_000),
});

/** /internal/v1/logs: other services' JSON lines (forwarded by the dev runner, or posted directly). */
export function logIngestRoutes(deps: { pipeline: ObsPipeline }) {
  const r = new Hono<AppEnv>();
  r.post('/logs', async (c) => {
    const req = await body(c, Ingest);
    let n = 0;
    for (const raw of req.lines) {
      const line = toNewLog(raw, req.service);
      if (!line) continue;
      deps.pipeline.pushLog({ ...line, service: req.service });
      n++;
    }
    return c.json({ accepted: n });
  });
  return r;
}
