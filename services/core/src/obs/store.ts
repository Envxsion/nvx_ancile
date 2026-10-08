/**
 * ------------------------------------------------------------------
 *  Title    |  Log and span store
 *  Ref      |  DESIGN.md §11.1, §11.5, §11.6
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keep every service's log lines and Core's spans where
 *           |  the Cockpit can query them: filter, follow live, export,
 *           |  and open a trace as a waterfall.
 *  How      |  Writers never wait on the database. Lines and spans go
 *           |  into a buffer that is flushed in batches (every 500 ms,
 *           |  or at 200 items). Once a batch of lines has its ids,
 *           |  live subscribers (the log tail) get it. If the database
 *           |  is unreachable, the batch is dropped after one retry and
 *           |  a single line says so on stderr: logging about logging
 *           |  must never loop back into the logger.
 *  Note     |  Memory* variants back the test harness.
 * ------------------------------------------------------------------
 */

import type { LogLevel, LogLine, LogQuery, SpanView, TraceSummary } from '@nvx/contracts';
import type { Sql } from 'postgres';
import type { SpanRecord } from './spans';

export interface NewLog {
  at: string;
  level: LogLevel;
  service: string;
  component: string | null;
  trace_id: string | null;
  span_id: string | null;
  msg: string;
  data: Record<string, unknown>;
}

export const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const PINO_LEVELS: Record<number, LogLevel> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

/** One JSON log line from any service (pino, structlog, our Python logger) as a row. */
export function toNewLog(raw: Record<string, unknown>, fallbackService = 'core'): NewLog | null {
  const msg = raw.msg ?? raw.message ?? raw.event;
  if (typeof msg !== 'string') return null;
  const rawLevel = raw.level;
  const level: LogLevel =
    typeof rawLevel === 'number'
      ? (PINO_LEVELS[rawLevel] ?? 'info')
      : typeof rawLevel === 'string' && rawLevel.toLowerCase() in LEVEL_RANK
        ? (rawLevel.toLowerCase() as LogLevel)
        : rawLevel === 'warning'
          ? 'warn'
          : rawLevel === 'critical'
            ? 'fatal'
            : 'info';
  const at =
    typeof raw.ts === 'string'
      ? raw.ts
      : typeof raw.time === 'number'
        ? new Date(raw.time).toISOString()
        : new Date().toISOString();
  const {
    msg: _m,
    message: _ms,
    event: _e,
    level: _l,
    ts: _t,
    time: _ti,
    service,
    component,
    trace_id,
    span_id,
    pid: _p,
    hostname: _h,
    ...data
  } = raw;
  return {
    at,
    level,
    service: typeof service === 'string' ? service : fallbackService,
    component: typeof component === 'string' ? component : null,
    trace_id: typeof trace_id === 'string' ? trace_id : null,
    span_id: typeof span_id === 'string' ? span_id : null,
    msg: msg.slice(0, 4_000),
    data,
  };
}

export interface Facets {
  services: string[];
  components: string[];
}

export interface ObsStore {
  insertLogs(lines: NewLog[]): Promise<LogLine[]>;
  queryLogs(q: LogQuery): Promise<LogLine[]>;
  logsAfter(id: number, q: Partial<LogQuery>, limit?: number): Promise<LogLine[]>;
  facets(): Promise<Facets>;
  insertSpans(spans: SpanRecord[]): Promise<void>;
  trace(traceId: string): Promise<{ spans: SpanView[]; logs: LogLine[] }>;
  traces(opts: { limit: number; before?: string; q?: string; errorsOnly?: boolean }): Promise<TraceSummary[]>;
  prune(opts: { logsBefore: Date; spansBefore: Date }): Promise<{ logs: number; spans: number }>;
}

/* ---- Filtering, shared ------------------------------------------------------ */

export function matches(line: LogLine, q: Partial<LogQuery>): boolean {
  if (q.level && LEVEL_RANK[line.level] < LEVEL_RANK[q.level]) return false;
  if (q.service && line.service !== q.service) return false;
  if (q.component && line.component !== q.component) return false;
  if (q.trace && line.trace_id !== q.trace) return false;
  if (q.since && line.at < q.since) return false;
  if (q.until && line.at > q.until) return false;
  if (q.q) {
    const needle = q.q.toLowerCase();
    if (!line.msg.toLowerCase().includes(needle) && !JSON.stringify(line.data).toLowerCase().includes(needle))
      return false;
  }
  return true;
}

const levelsAtLeast = (l: LogLevel) =>
  (Object.keys(LEVEL_RANK) as LogLevel[]).filter((k) => LEVEL_RANK[k] >= LEVEL_RANK[l]);

function spanView(s: SpanRecord): SpanView {
  return {
    trace_id: s.traceId,
    span_id: s.spanId,
    parent_span_id: s.parentSpanId,
    service: s.service,
    name: s.name,
    kind: s.kind,
    start_at: s.startAt.toISOString(),
    end_at: s.endAt?.toISOString() ?? null,
    duration_ms: s.endAt ? s.endAt.getTime() - s.startAt.getTime() : null,
    status: s.status,
    attrs: s.attrs,
    events: s.events,
  };
}

function summarise(spans: SpanView[]): TraceSummary | null {
  if (!spans.length) return null;
  const sorted = [...spans].sort((a, b) => a.start_at.localeCompare(b.start_at));
  const root =
    sorted.find((s) => !s.parent_span_id || !spans.some((p) => p.span_id === s.parent_span_id)) ?? sorted[0];
  if (!root) return null;
  const end = Math.max(...spans.map((s) => (s.end_at ? Date.parse(s.end_at) : Date.parse(s.start_at))));
  const runId = spans.map((s) => s.attrs.run_id).find((v): v is string => typeof v === 'string') ?? null;
  return {
    trace_id: root.trace_id,
    name: root.name,
    service: root.service,
    start_at: root.start_at,
    duration_ms: end - Date.parse(root.start_at),
    status: spans.some((s) => s.status === 'error') ? 'error' : root.status,
    spans: spans.length,
    run_id: runId,
  };
}

/* ---- In memory (tests) ------------------------------------------------------- */

export class MemoryObsStore implements ObsStore {
  logs: LogLine[] = [];
  spans: SpanRecord[] = [];
  private nextId = 1;

  async insertLogs(lines: NewLog[]) {
    const rows = lines.map((l) => ({ ...l, id: this.nextId++ }));
    this.logs.push(...rows);
    return rows;
  }
  async queryLogs(q: LogQuery) {
    return this.logs
      .filter((l) => matches(l, q) && (q.before === undefined || l.id < q.before))
      .sort((a, b) => b.id - a.id)
      .slice(0, q.limit);
  }
  async logsAfter(id: number, q: Partial<LogQuery>, limit = 500) {
    return this.logs.filter((l) => l.id > id && matches(l, q)).slice(0, limit);
  }
  async facets() {
    return {
      services: [...new Set(this.logs.map((l) => l.service))].sort(),
      components: [...new Set(this.logs.flatMap((l) => (l.component ? [l.component] : [])))].sort(),
    };
  }
  async insertSpans(spans: SpanRecord[]) {
    this.spans.push(...spans);
  }
  async trace(traceId: string) {
    return {
      spans: this.spans.filter((s) => s.traceId === traceId).map(spanView),
      logs: this.logs.filter((l) => l.trace_id === traceId),
    };
  }
  async traces(opts: { limit: number; before?: string; q?: string; errorsOnly?: boolean }) {
    const ids = [...new Set(this.spans.map((s) => s.traceId))];
    return ids
      .flatMap((id) => {
        const s = summarise(this.spans.filter((x) => x.traceId === id).map(spanView));
        return s ? [s] : [];
      })
      .filter((t) => (!opts.before || t.start_at < opts.before) && (!opts.errorsOnly || t.status === 'error'))
      .filter(
        (t) =>
          !opts.q || t.name.toLowerCase().includes(opts.q.toLowerCase()) || t.trace_id.startsWith(opts.q),
      )
      .sort((a, b) => b.start_at.localeCompare(a.start_at))
      .slice(0, opts.limit);
  }
  async prune(opts: { logsBefore: Date; spansBefore: Date }) {
    const l = this.logs.length;
    const s = this.spans.length;
    this.logs = this.logs.filter((x) => x.at >= opts.logsBefore.toISOString());
    this.spans = this.spans.filter((x) => x.startAt >= opts.spansBefore);
    return { logs: l - this.logs.length, spans: s - this.spans.length };
  }
}

/* ---- Postgres ------------------------------------------------------------------- */

interface LogRow {
  id: string | number;
  at: Date;
  level: string;
  service: string;
  component: string | null;
  trace_id: string | null;
  span_id: string | null;
  msg: string;
  data: Record<string, unknown>;
}

const logLine = (r: LogRow): LogLine => ({
  id: Number(r.id),
  at: r.at.toISOString(),
  level: r.level as LogLevel,
  service: r.service,
  component: r.component,
  trace_id: r.trace_id,
  span_id: r.span_id,
  msg: r.msg,
  data: r.data ?? {},
});

interface SpanRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  service: string;
  name: string;
  kind: string;
  start_at: Date;
  end_at: Date | null;
  status: string;
  attrs: Record<string, unknown>;
  events: unknown[];
}

const spanRow = (r: SpanRow): SpanView => ({
  trace_id: r.trace_id,
  span_id: r.span_id,
  parent_span_id: r.parent_span_id,
  service: r.service,
  name: r.name,
  kind: r.kind,
  start_at: r.start_at.toISOString(),
  end_at: r.end_at?.toISOString() ?? null,
  duration_ms: r.end_at ? r.end_at.getTime() - r.start_at.getTime() : null,
  status: (['ok', 'error'].includes(r.status) ? r.status : 'unset') as SpanView['status'],
  attrs: r.attrs ?? {},
  events: r.events ?? [],
});

export class PgObsStore implements ObsStore {
  private facetCache: { at: number; value: Facets } | null = null;

  constructor(private readonly sql: Sql) {}

  async insertLogs(lines: NewLog[]) {
    if (!lines.length) return [];
    // One round trip for the batch: the rows travel as one JSON array.
    const out = await this.sql<LogRow[]>`
      insert into core.logs (at, level, service, component, trace_id, span_id, msg, data)
      select at, level, service, component, trace_id, span_id, msg, coalesce(data, '{}'::jsonb)
      from jsonb_to_recordset(${this.sql.json(lines as never)})
        as x(at timestamptz, level text, service text, component text, trace_id text, span_id text, msg text, data jsonb)
      returning id, at, level, service, component, trace_id, span_id, msg, data`;
    return out.map(logLine);
  }

  private where(q: Partial<LogQuery>) {
    const sql = this.sql;
    const parts = [sql`true`];
    if (q.level) parts.push(sql`level = any(${levelsAtLeast(q.level)})`);
    if (q.service) parts.push(sql`service = ${q.service}`);
    if (q.component) parts.push(sql`component = ${q.component}`);
    if (q.trace) parts.push(sql`trace_id = ${q.trace}`);
    if (q.since) parts.push(sql`at >= ${q.since}`);
    if (q.until) parts.push(sql`at <= ${q.until}`);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      parts.push(sql`(msg ilike ${like} or data::text ilike ${like})`);
    }
    return parts.reduce((a, b) => sql`${a} and ${b}`);
  }

  async queryLogs(q: LogQuery) {
    const before = q.before !== undefined ? this.sql`and id < ${q.before}` : this.sql``;
    const rows = await this.sql<LogRow[]>`
      select id, at, level, service, component, trace_id, span_id, msg, data from core.logs
      where ${this.where(q)} ${before}
      order by id desc limit ${q.limit}`;
    return rows.map(logLine);
  }

  async logsAfter(id: number, q: Partial<LogQuery>, limit = 500) {
    const rows = await this.sql<LogRow[]>`
      select id, at, level, service, component, trace_id, span_id, msg, data from core.logs
      where id > ${id} and ${this.where(q)} order by id asc limit ${limit}`;
    return rows.map(logLine);
  }

  async facets() {
    if (this.facetCache && Date.now() - this.facetCache.at < 30_000) return this.facetCache.value;
    const since = new Date(Date.now() - 7 * 86_400_000);
    const [services, components] = await Promise.all([
      this.sql<{ v: string }[]>`select distinct service as v from core.logs where at > ${since} order by 1`,
      this.sql<
        { v: string }[]
      >`select distinct component as v from core.logs where at > ${since} and component is not null order by 1`,
    ]);
    const value = { services: services.map((r) => r.v), components: components.map((r) => r.v) };
    this.facetCache = { at: Date.now(), value };
    return value;
  }

  async insertSpans(spans: SpanRecord[]) {
    if (!spans.length) return;
    const rows = spans.map((s) => ({
      trace_id: s.traceId,
      span_id: s.spanId,
      parent_span_id: s.parentSpanId,
      service: s.service,
      name: s.name,
      kind: s.kind,
      start_at: s.startAt.toISOString(),
      end_at: s.endAt?.toISOString() ?? null,
      status: s.status,
      attrs: s.attrs,
      events: s.events,
    }));
    await this.sql`
      insert into core.spans (trace_id, span_id, parent_span_id, service, name, kind, start_at, end_at, status, attrs, events)
      select trace_id, span_id, parent_span_id, service, name, kind, start_at, end_at, status,
             coalesce(attrs, '{}'::jsonb), coalesce(events, '[]'::jsonb)
      from jsonb_to_recordset(${this.sql.json(rows as never)})
        as x(trace_id text, span_id text, parent_span_id text, service text, name text, kind text,
             start_at timestamptz, end_at timestamptz, status text, attrs jsonb, events jsonb)
      on conflict (trace_id, span_id) do nothing`;
  }

  async trace(traceId: string) {
    const [spans, logs] = await Promise.all([
      this.sql<SpanRow[]>`select * from core.spans where trace_id = ${traceId} order by start_at limit 2000`,
      this.sql<LogRow[]>`
        select id, at, level, service, component, trace_id, span_id, msg, data from core.logs
        where trace_id = ${traceId} order by id limit 2000`,
    ]);
    return { spans: spans.map(spanRow), logs: logs.map(logLine) };
  }

  async traces(opts: { limit: number; before?: string; q?: string; errorsOnly?: boolean }) {
    const sql = this.sql;
    const before = opts.before ? sql`and r.start_at < ${opts.before}` : sql``;
    const like = opts.q ? `%${opts.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const q = like ? sql`and (r.name ilike ${like} or r.trace_id like ${`${opts.q}%`})` : sql``;
    const rows = await sql<
      (SpanRow & { n: string; last_end: Date | null; errors: string; run_id: string | null })[]
    >`
      select r.*, agg.n, agg.last_end, agg.errors, agg.run_id
      from (
        -- A trace can have several roots (the request, then its run): list it once, by the first.
        select distinct on (trace_id) * from core.spans
        where parent_span_id is null
        order by trace_id, start_at
      ) r
      join lateral (
        select count(*) as n, max(coalesce(s.end_at, s.start_at)) as last_end,
               count(*) filter (where s.status = 'error') as errors,
               max(s.attrs->>'run_id') as run_id
        from core.spans s where s.trace_id = r.trace_id
      ) agg on true
      where true ${before} ${q}
      ${opts.errorsOnly ? sql`and agg.errors > 0` : sql``}
      order by r.start_at desc limit ${opts.limit}`;
    return rows.map((r) => ({
      trace_id: r.trace_id,
      name: r.name,
      service: r.service,
      start_at: r.start_at.toISOString(),
      duration_ms: r.last_end ? r.last_end.getTime() - r.start_at.getTime() : null,
      status: Number(r.errors) > 0 ? ('error' as const) : (spanRow(r).status as TraceSummary['status']),
      spans: Number(r.n),
      run_id: r.run_id,
    }));
  }

  async prune(opts: { logsBefore: Date; spansBefore: Date }) {
    const logs = await this.sql`delete from core.logs where at < ${opts.logsBefore}`;
    const spans = await this.sql`delete from core.spans where start_at < ${opts.spansBefore}`;
    return { logs: logs.count, spans: spans.count };
  }
}

/* ---- The batching writer and the live tail --------------------------------------- */

type Listener = (lines: LogLine[]) => void;

export class ObsPipeline {
  private logBuf: NewLog[] = [];
  private spanBuf: SpanRecord[] = [];
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<Listener>();
  private flushing: Promise<void> | null = null;
  private warned = 0;

  constructor(
    readonly store: ObsStore,
    private readonly opts: { flushMs?: number; maxBatch?: number; minLevel?: LogLevel } = {},
  ) {}

  pushLog(line: NewLog): void {
    if (this.opts.minLevel && LEVEL_RANK[line.level] < LEVEL_RANK[this.opts.minLevel]) return;
    // A runaway logger must not grow the buffer without bound.
    if (this.logBuf.length > 20_000) this.logBuf.shift();
    this.logBuf.push(line);
    this.schedule();
  }

  pushSpan(span: SpanRecord): void {
    if (this.spanBuf.length > 20_000) this.spanBuf.shift();
    this.spanBuf.push(span);
    this.schedule();
  }

  /** Live lines as they are stored, with their ids. Returns an unsubscribe. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private schedule(): void {
    if (this.logBuf.length + this.spanBuf.length >= (this.opts.maxBatch ?? 200)) {
      void this.flush();
      return;
    }
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.opts.flushMs ?? 500);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.flushing) await this.flushing;
    const logs = this.logBuf.splice(0, this.logBuf.length);
    const spans = this.spanBuf.splice(0, this.spanBuf.length);
    if (!logs.length && !spans.length) return;
    this.flushing = (async () => {
      try {
        const stored = await this.store.insertLogs(logs);
        if (stored.length) for (const l of this.listeners) l(stored);
        await this.store.insertSpans(spans);
      } catch (err) {
        if (this.warned++ % 50 === 0)
          process.stderr.write(
            `[core] could not store ${logs.length} log lines and ${spans.length} spans: ${(err as Error).message}\n`,
          );
      }
    })();
    await this.flushing;
    this.flushing = null;
  }

  async stop(): Promise<void> {
    await this.flush();
  }
}
