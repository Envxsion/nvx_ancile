/**
 * ------------------------------------------------------------------
 *  Title    |  Usage report
 *  Ref      |  docs/api.md (Usage) · contracts usage.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Personal token and cost totals for Settings → Usage:
 *           |  today by hour, the last 7 or 30 days by day, split by
 *           |  engine and by model.
 *  How      |  Every answer records its usage on its message (tokens
 *           |  in, out and cached, cost). A source groups those by
 *           |  local bucket, engine and model: in Postgres with one
 *           |  grouped query over the partial index on created_at
 *           |  (migration 0016), in memory for tests. build() fills
 *           |  the empty buckets and folds the long tail of models.
 *           |  The engine is the answer's: Claude Code (its provenance,
 *           |  a claude_code run, or a claude-code/<model> answer), the
 *           |  lab (an agent run), the model gateway (chat and flows),
 *           |  else other. claudeCodeUsage() is Settings → Usage's
 *           |  Claude Code block: today, the last 7 days by day, the
 *           |  cache hit rate, the busiest threads, and how much came
 *           |  from sessions imported from the terminal.
 *           |  A Claude Code answer is a mirror of its transcript and
 *           |  counts once, where it lives now: a copy a sync replaced
 *           |  (deleted) or one in a deleted thread (the session comes
 *           |  back into a new thread) is left out. Other engines'
 *           |  answers count even after deletion: that spend was real.
 *  Note     |  Claude Code's cost is its own estimate at API list
 *           |  prices; the report says how much of the total that is.
 * ------------------------------------------------------------------
 */

import {
  CLAUDE_CODE_MODEL_PREFIX,
  type ClaudeCodeUsage,
  type UsageEngine,
  type UsageRange,
  type UsageReport,
  type UsageTotals,
} from '@nvx/contracts';
import type { Sql } from 'postgres';
import type { MessageRecord } from '../threads/repo';
import type { UsageArchiveRow } from './archive';
import type { StoredCall } from './ledger';

/** One group: a local bucket ("2026-10-12" or "2026-10-12T14:00"), an engine and a model. */
export interface UsageRow {
  bucket: string;
  engine: UsageEngine;
  model_id: string | null;
  /** OpenRouter's provider that served it (usage.served.provider); null elsewhere. */
  provider?: string | null;
  /** What the call was for: 'chat' for answers kept on a message, else the ledger's purpose. */
  purpose?: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd: number;
  /** Of cost_usd, Claude Code's estimate. */
  estimated_usd: number;
  answers: number;
  /** Model calls in the group; absent counts as `answers` (a message is one call). */
  calls?: number;
}

export interface UsageQuery {
  workspaceId: string;
  tz: string;
  bucket: 'hour' | 'day';
  from: Date;
  to: Date;
  /** Only answers this OpenRouter provider served. */
  provider?: string | undefined;
}

/** One thread's Claude Code usage over a range. */
export interface ThreadUsageRow extends UsageTotals {
  thread_id: string;
  title: string | null;
}

export interface UsageSource {
  rows(q: UsageQuery): Promise<UsageRow[]>;
  /** The busiest threads by Claude Code tokens over the range. */
  claudeCodeThreads?(q: UsageQuery, limit: number): Promise<ThreadUsageRow[]>;
  /** Of Claude Code's answers over the range, those brought in from its own transcripts. */
  claudeCodeImported?(q: UsageQuery): Promise<ImportedUsage>;
}

/** Claude Code answers brought in from a transcript (a session run in the terminal), not written by a turn here. */
export interface ImportedUsage extends UsageTotals {
  /** Distinct Claude Code sessions those answers came from. */
  sessions: number;
}

export const TOP_MODELS = 6;
/** Claude Code as a model answers as claude-code/<model>. */
const CC_LIKE = `${CLAUDE_CODE_MODEL_PREFIX}%`;

const DAY_MS = 86_400_000;

/* ---- time zones ------------------------------------------------------------ */

/** A zone Intl knows, else null. */
export function validZone(tz: string | undefined): string | null {
  if (!tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return null;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** The local calendar parts of an instant in a zone. */
export function parts(tz: string, at: number) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = Object.fromEntries(
    f.formatToParts(new Date(at)).map((x) => [x.type, x.value]),
  );
  const n = (k: string) => Number(p[k] ?? 0);
  return { y: n('year'), m: n('month'), d: n('day'), h: n('hour') % 24, mi: n('minute'), s: n('second') };
}

/** How far a zone is ahead of UTC at an instant, in ms. */
function offset(tz: string, at: number): number {
  const p = parts(tz, at);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(at / 1000) * 1000;
}

/** The instant of local midnight for a local date in a zone. */
export function localMidnight(tz: string, y: number, m: number, d: number): number {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offset(tz, guess);
  return guess - offset(tz, first);
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** The range's bounds and every bucket key in it, oldest first. */
export function window(range: UsageRange, tz: string, now: number) {
  const p = parts(tz, now);
  const days = range === 'day' ? 1 : range === 'week' ? 7 : 30;
  const first = new Date(Date.UTC(p.y, p.m - 1, p.d) - (days - 1) * DAY_MS);
  const from = localMidnight(tz, first.getUTCFullYear(), first.getUTCMonth() + 1, first.getUTCDate());
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d) + DAY_MS);
  const to = localMidnight(tz, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  const keys: string[] = [];
  if (range === 'day') for (let h = 0; h < 24; h++) keys.push(`${dayKey(p.y, p.m, p.d)}T${pad(h)}:00`);
  else
    for (let i = 0; i < days; i++) {
      const d = new Date(first.getTime() + i * DAY_MS);
      keys.push(dayKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
    }
  return {
    from: new Date(from),
    to: new Date(to),
    bucket: range === 'day' ? ('hour' as const) : ('day' as const),
    keys,
  };
}

/** An instant's bucket key in a zone. */
export function bucketOf(tz: string, at: number, bucket: 'hour' | 'day'): string {
  const p = parts(tz, at);
  return bucket === 'day' ? dayKey(p.y, p.m, p.d) : `${dayKey(p.y, p.m, p.d)}T${pad(p.h)}:00`;
}

/* ---- building the report ----------------------------------------------------- */

const zero = (): UsageTotals => ({
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cost_usd: 0,
  answers: 0,
});
const add = (t: UsageTotals, r: UsageRow) => {
  t.input_tokens += r.input_tokens;
  t.output_tokens += r.output_tokens;
  t.cached_tokens += r.cached_tokens;
  t.cost_usd += r.cost_usd;
  t.answers += r.answers;
};
const tokens = (t: Pick<UsageTotals, 'input_tokens' | 'output_tokens'>) => t.input_tokens + t.output_tokens;
const money = (n: number) => Math.round(n * 1e6) / 1e6;
const ENGINES: UsageEngine[] = ['gateway', 'claude_code', 'lab', 'other'];

export function buildReport(
  range: UsageRange,
  tz: string,
  w: { from: Date; to: Date; bucket: 'hour' | 'day'; keys: string[] },
  rows: UsageRow[],
  topModels = TOP_MODELS,
): UsageReport {
  const totals = zero();
  let estimated = 0;
  const series = new Map(
    w.keys.map((k) => [k, { start: k, tokens: 0, cost_usd: 0, by_engine: {} as Record<string, number> }]),
  );
  const engines = new Map<UsageEngine, UsageTotals>();
  const models = new Map<string, UsageTotals & { model_id: string | null; engine: UsageEngine }>();
  const providers = new Map<string, UsageTotals>();
  const purposes = new Map<string, UsageTotals & { calls: number }>();
  for (const r of rows) {
    add(totals, r);
    estimated += r.estimated_usd;
    const s = series.get(r.bucket);
    if (s) {
      s.tokens += tokens(r);
      s.cost_usd += r.cost_usd;
      s.by_engine[r.engine] = (s.by_engine[r.engine] ?? 0) + tokens(r);
    }
    const e = engines.get(r.engine) ?? zero();
    add(e, r);
    engines.set(r.engine, e);
    const key = `${r.engine}|${r.model_id ?? ''}`;
    const m = models.get(key) ?? { ...zero(), model_id: r.model_id, engine: r.engine };
    add(m, r);
    models.set(key, m);
    const purpose = r.purpose ?? 'chat';
    const pu = purposes.get(purpose) ?? { ...zero(), calls: 0 };
    add(pu, r);
    pu.calls += r.calls ?? r.answers;
    purposes.set(purpose, pu);
    if (r.provider) {
      const p = providers.get(r.provider) ?? zero();
      add(p, r);
      providers.set(r.provider, p);
    }
  }
  const sorted = [...models.values()].sort((a, b) => tokens(b) - tokens(a) || b.cost_usd - a.cost_usd);
  const top = sorted.slice(0, topModels);
  const rest = sorted.slice(topModels);
  if (rest.length) {
    const other = { ...zero(), model_id: null, engine: 'other' as UsageEngine };
    for (const m of rest) add(other, { ...m, bucket: '', estimated_usd: 0 });
    top.push(other);
  }
  const round = <T extends UsageTotals>(t: T): T => ({ ...t, cost_usd: money(t.cost_usd) });
  return {
    range,
    tz,
    from: w.from.toISOString(),
    to: w.to.toISOString(),
    bucket: w.bucket,
    totals: round(totals),
    series: [...series.values()].map((s) => ({ ...s, cost_usd: money(s.cost_usd) })),
    by_engine: ENGINES.filter((e) => engines.has(e)).map((engine) =>
      round({ ...(engines.get(engine) as UsageTotals), engine }),
    ),
    by_model: top.map(round),
    by_purpose: [...purposes.entries()]
      .sort((a, b) => tokens(b[1]) - tokens(a[1]) || b[1].cost_usd - a[1].cost_usd)
      .map(([purpose, t]) => round({ ...t, purpose })),
    by_provider: [...providers.entries()]
      .sort((a, b) => tokens(b[1]) - tokens(a[1]))
      .map(([provider, t]) => round({ ...t, provider })),
    estimated_cost_usd: money(estimated),
  };
}

/* ---- sources ------------------------------------------------------------------ */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The engine an answer belongs to. */
export function engineOf(provenance: unknown, runKind: string | null, modelId: string | null): UsageEngine {
  const p = isObj(provenance) ? provenance : {};
  if ('claude_code' in p || runKind === 'claude_code' || modelId?.startsWith(CLAUDE_CODE_MODEL_PREFIX))
    return 'claude_code';
  if ('lab' in p || runKind === 'agent') return 'lab';
  if (runKind === 'chat_turn' || runKind === 'flow_try' || modelId) return 'gateway';
  return 'other';
}

/** An answer brought in from a transcript: Claude Code's provenance, not marked live, and no Claude Code run. */
export function importedAnswer(provenance: unknown, runKind: string | null): boolean {
  const p = isObj(provenance) ? provenance : {};
  const cc = p.claude_code;
  return isObj(cc) && cc.live !== true && runKind !== 'claude_code';
}

export class PgUsageSource implements UsageSource {
  constructor(private readonly sql: Sql) {}

  async rows(q: UsageQuery): Promise<UsageRow[]> {
    const fmt = q.bucket === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM-DD"T"HH24":00"';
    const rows = await this.sql<
      {
        bucket: string;
        engine: UsageEngine;
        model_id: string | null;
        provider: string | null;
        input_tokens: string;
        output_tokens: string;
        cached_tokens: string;
        cost_usd: string | number;
        estimated_usd: string | number;
        answers: number;
        purpose: string;
        calls: number;
      }[]
    >`
      with u as (
        select
          to_char(m.created_at at time zone ${q.tz}, ${fmt}) as bucket,
          case
            when m.provenance ? 'claude_code' or r.kind = 'claude_code'
              or m.model_id like ${CC_LIKE} then 'claude_code'
            when m.provenance ? 'lab' or r.kind = 'agent' then 'lab'
            when r.kind in ('chat_turn', 'flow_try') or m.model_id is not null then 'gateway'
            else 'other'
          end as engine,
          m.model_id,
          m.usage->'served'->>'provider' as provider,
          coalesce((m.usage->>'input_tokens')::bigint, 0) as i,
          coalesce((m.usage->>'output_tokens')::bigint, 0) as o,
          coalesce((m.usage->>'cached_tokens')::bigint, 0) as c,
          coalesce((m.usage->>'cost_usd')::numeric, 0) as cost,
          1 as n,
          'chat' as purpose,
          1 as calls
        from core.messages m
        join core.threads t on t.id = m.thread_id
        left join core.runs r on r.id = m.run_id
        where m.usage is not null
          and m.created_at >= ${q.from}
          and m.created_at < ${q.to}
          and t.workspace_id = ${q.workspaceId}
          and (${q.provider ?? null}::text is null or m.usage->'served'->>'provider' = ${q.provider ?? null})
          and ((m.deleted_at is null and t.deleted_at is null)
            or not coalesce(m.provenance ? 'claude_code' or r.kind = 'claude_code' or m.model_id like ${CC_LIKE}, false))
        union all
        -- Answers of threads that were purged, rolled up by usage/archive.ts, so a purge changes no total.
        select
          to_char(a.bucket_at at time zone ${q.tz}, ${fmt}),
          a.engine, a.model_id, a.provider,
          a.input_tokens, a.output_tokens, a.cached_tokens, a.cost_usd, a.answers, 'chat', a.answers
        from core.usage_archive a
        where a.workspace_id = ${q.workspaceId}
          and a.bucket_at >= ${q.from}
          and a.bucket_at < ${q.to}
          and (${q.provider ?? null}::text is null or a.provider = ${q.provider ?? null})
        union all
        -- Every model call that is not a chat answer (usage/ledger.ts), with what it was for.
        select
          to_char(k.at at time zone ${q.tz}, ${fmt}),
          k.engine, k.model_id, k.provider,
          k.input_tokens, k.output_tokens, k.cached_tokens, k.cost_usd, 0, k.purpose, 1
        from core.model_calls k
        where k.workspace_id = ${q.workspaceId}
          and k.at >= ${q.from}
          and k.at < ${q.to}
          and (${q.provider ?? null}::text is null or k.provider = ${q.provider ?? null})
      )
      select bucket, engine, model_id, provider,
        sum(i)::text as input_tokens, sum(o)::text as output_tokens, sum(c)::text as cached_tokens,
        sum(cost)::float8 as cost_usd,
        sum(case when engine = 'claude_code' then cost else 0 end)::float8 as estimated_usd,
        sum(n)::int as answers, purpose, sum(calls)::int as calls
      from u
      group by bucket, engine, model_id, provider, purpose`;
    return rows.map((r) => ({
      bucket: r.bucket,
      engine: r.engine,
      model_id: r.model_id,
      provider: r.provider,
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cached_tokens: Number(r.cached_tokens),
      cost_usd: Number(r.cost_usd),
      estimated_usd: Number(r.estimated_usd),
      answers: r.answers,
      purpose: r.purpose,
      calls: r.calls,
    }));
  }

  async claudeCodeThreads(q: UsageQuery, limit: number): Promise<ThreadUsageRow[]> {
    const rows = await this.sql<
      {
        thread_id: string;
        title: string | null;
        input_tokens: string;
        output_tokens: string;
        cached_tokens: string;
        cost_usd: string | number;
        answers: number;
      }[]
    >`
      select m.thread_id, t.title,
        sum(coalesce((m.usage->>'input_tokens')::bigint, 0))::text as input_tokens,
        sum(coalesce((m.usage->>'output_tokens')::bigint, 0))::text as output_tokens,
        sum(coalesce((m.usage->>'cached_tokens')::bigint, 0))::text as cached_tokens,
        sum(coalesce((m.usage->>'cost_usd')::numeric, 0))::float8 as cost_usd,
        count(*)::int as answers
      from core.messages m
      join core.threads t on t.id = m.thread_id
      left join core.runs r on r.id = m.run_id
      where m.usage is not null
        and m.created_at >= ${q.from}
        and m.created_at < ${q.to}
        and t.workspace_id = ${q.workspaceId}
        and m.deleted_at is null
        and t.deleted_at is null
        and (m.provenance ? 'claude_code' or r.kind = 'claude_code' or m.model_id like ${CC_LIKE})
      group by m.thread_id, t.title
      order by sum(coalesce((m.usage->>'input_tokens')::bigint, 0)
        + coalesce((m.usage->>'output_tokens')::bigint, 0)) desc
      limit ${limit}`;
    return rows.map((r) => ({
      thread_id: r.thread_id,
      title: r.title,
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cached_tokens: Number(r.cached_tokens),
      cost_usd: Number(r.cost_usd),
      answers: r.answers,
    }));
  }

  async claudeCodeImported(q: UsageQuery): Promise<ImportedUsage> {
    const [r] = await this.sql<
      {
        input_tokens: string;
        output_tokens: string;
        cached_tokens: string;
        cost_usd: string | number;
        answers: number;
        sessions: number;
      }[]
    >`
      select
        coalesce(sum(coalesce((m.usage->>'input_tokens')::bigint, 0)), 0)::text as input_tokens,
        coalesce(sum(coalesce((m.usage->>'output_tokens')::bigint, 0)), 0)::text as output_tokens,
        coalesce(sum(coalesce((m.usage->>'cached_tokens')::bigint, 0)), 0)::text as cached_tokens,
        coalesce(sum(coalesce((m.usage->>'cost_usd')::numeric, 0)), 0)::float8 as cost_usd,
        count(*)::int as answers,
        count(distinct m.provenance->'claude_code'->>'session_id')::int as sessions
      from core.messages m
      join core.threads t on t.id = m.thread_id
      left join core.runs r on r.id = m.run_id
      where m.usage is not null
        and m.created_at >= ${q.from}
        and m.created_at < ${q.to}
        and t.workspace_id = ${q.workspaceId}
        and m.deleted_at is null
        and t.deleted_at is null
        and m.provenance ? 'claude_code'
        and coalesce(m.provenance->'claude_code'->>'live', 'false') <> 'true'
        and r.kind is distinct from 'claude_code'`;
    return {
      input_tokens: Number(r?.input_tokens ?? 0),
      output_tokens: Number(r?.output_tokens ?? 0),
      cached_tokens: Number(r?.cached_tokens ?? 0),
      cost_usd: Number(r?.cost_usd ?? 0),
      answers: r?.answers ?? 0,
      sessions: r?.sessions ?? 0,
    };
  }
}

/**
 * What answers have cost since an instant, for a flow's month_spend_usd
 * fact: the gateway and anything else that bills, never Claude Code (its
 * cost is an estimate of what your Claude plan already includes).
 */
export async function spendUsd(sql: Sql, since: Date): Promise<number> {
  const [r] = await sql<{ usd: number | null }[]>`
    select
      coalesce((
        select sum(coalesce((m.usage->>'cost_usd')::float8, 0))
        from core.messages m
        left join core.runs r on r.id = m.run_id
        where m.usage is not null
          and m.created_at >= ${since}
          and not coalesce(m.provenance ? 'claude_code' or r.kind = 'claude_code' or m.model_id like ${CC_LIKE}, false)
      ), 0)
      -- plus the answers of purged threads (usage/archive.ts), which are never Claude Code
      + coalesce((select sum(a.cost_usd)::float8 from core.usage_archive a where a.bucket_at >= ${since}), 0)
      -- plus every other model call (fact-checks, memory, titles; usage/ledger.ts), never Claude Code's
      + coalesce((select sum(k.cost_usd)::float8 from core.model_calls k
          where k.at >= ${since} and k.engine <> 'claude_code'), 0) as usd`;
  return Number(r?.usd ?? 0);
}

/** For tests: the same grouping over in-memory messages. */
export class MemoryUsageSource implements UsageSource {
  constructor(
    private readonly deps: {
      messages(): Iterable<MessageRecord>;
      workspaceOf(threadId: string): string | null;
      runKind(runId: string): string | null;
      titleOf?(threadId: string): string | null;
      /** Whether the thread was deleted; none are by default. */
      threadDeleted?(threadId: string): boolean;
      /** Rows rolled up from purged threads (MemoryThreadRepo.usageArchive); none by default. */
      archive?(): Iterable<UsageArchiveRow>;
      /** Calls the ledger kept (MemoryCallLedger.calls); none by default. */
      calls?(): Iterable<StoredCall>;
    },
  ) {}

  /** A Claude Code answer that is a replaced copy, or sits in a deleted thread, so is not counted. */
  private goneMirror(m: MessageRecord, engine: UsageEngine): boolean {
    return engine === 'claude_code' && (!!m.deleted_at || !!this.deps.threadDeleted?.(m.thread_id));
  }

  async claudeCodeImported(q: UsageQuery): Promise<ImportedUsage> {
    const out: ImportedUsage = { ...zero(), sessions: 0 };
    const sessions = new Set<string>();
    for (const m of this.deps.messages()) {
      if (!m.usage) continue;
      const at = Date.parse(m.created_at);
      if (at < q.from.getTime() || at >= q.to.getTime()) continue;
      if (this.deps.workspaceOf(m.thread_id) !== q.workspaceId) continue;
      const kind = m.run_id ? this.deps.runKind(m.run_id) : null;
      if (this.goneMirror(m, 'claude_code') || !importedAnswer(m.provenance, kind)) continue;
      out.input_tokens += m.usage.input_tokens;
      out.output_tokens += m.usage.output_tokens;
      out.cached_tokens += m.usage.cached_tokens ?? 0;
      out.cost_usd += m.usage.cost_usd;
      out.answers += 1;
      const sid = (m.provenance?.claude_code as { session_id?: unknown } | undefined)?.session_id;
      if (typeof sid === 'string') sessions.add(sid);
    }
    out.sessions = sessions.size;
    return out;
  }

  async claudeCodeThreads(q: UsageQuery, limit: number): Promise<ThreadUsageRow[]> {
    const by = new Map<string, ThreadUsageRow>();
    for (const m of this.deps.messages()) {
      if (!m.usage) continue;
      const at = Date.parse(m.created_at);
      if (at < q.from.getTime() || at >= q.to.getTime()) continue;
      if (this.deps.workspaceOf(m.thread_id) !== q.workspaceId) continue;
      if (engineOf(m.provenance, m.run_id ? this.deps.runKind(m.run_id) : null, m.model_id) !== 'claude_code')
        continue;
      if (this.goneMirror(m, 'claude_code')) continue;
      const r = by.get(m.thread_id) ?? {
        thread_id: m.thread_id,
        title: this.deps.titleOf?.(m.thread_id) ?? null,
        ...zero(),
      };
      r.input_tokens += m.usage.input_tokens;
      r.output_tokens += m.usage.output_tokens;
      r.cached_tokens += m.usage.cached_tokens ?? 0;
      r.cost_usd += m.usage.cost_usd;
      r.answers += 1;
      by.set(m.thread_id, r);
    }
    return [...by.values()].sort((a, b) => tokens(b) - tokens(a)).slice(0, limit);
  }

  async rows(q: UsageQuery): Promise<UsageRow[]> {
    const by = new Map<string, UsageRow>();
    for (const m of this.deps.messages()) {
      if (!m.usage) continue;
      const at = Date.parse(m.created_at);
      if (at < q.from.getTime() || at >= q.to.getTime()) continue;
      if (this.deps.workspaceOf(m.thread_id) !== q.workspaceId) continue;
      const provider = m.usage.served?.provider ?? null;
      if (q.provider && provider !== q.provider) continue;
      const engine = engineOf(m.provenance, m.run_id ? this.deps.runKind(m.run_id) : null, m.model_id);
      if (this.goneMirror(m, engine)) continue;
      const bucket = bucketOf(q.tz, at, q.bucket);
      const key = `${bucket}|${engine}|${m.model_id ?? ''}|${provider ?? ''}`;
      const r = by.get(key) ?? {
        bucket,
        engine,
        model_id: m.model_id,
        provider,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        cost_usd: 0,
        estimated_usd: 0,
        answers: 0,
        purpose: 'chat',
        calls: 0,
      };
      r.input_tokens += m.usage.input_tokens;
      r.output_tokens += m.usage.output_tokens;
      r.cached_tokens += m.usage.cached_tokens ?? 0;
      r.cost_usd += m.usage.cost_usd;
      if (engine === 'claude_code') r.estimated_usd += m.usage.cost_usd;
      r.answers += 1;
      r.calls = (r.calls ?? 0) + 1;
      by.set(key, r);
    }
    for (const a of this.deps.archive?.() ?? []) {
      if (a.workspace_id !== q.workspaceId) continue;
      const at = Date.parse(a.bucket_at);
      if (at < q.from.getTime() || at >= q.to.getTime()) continue;
      if (q.provider && a.provider !== q.provider) continue;
      const bucket = bucketOf(q.tz, at, q.bucket);
      const key = `${bucket}|${a.engine}|${a.model_id ?? ''}|${a.provider ?? ''}`;
      const r = by.get(key) ?? {
        bucket,
        engine: a.engine,
        model_id: a.model_id,
        provider: a.provider,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        cost_usd: 0,
        estimated_usd: 0,
        answers: 0,
        purpose: 'chat',
        calls: 0,
      };
      r.input_tokens += a.input_tokens;
      r.output_tokens += a.output_tokens;
      r.cached_tokens += a.cached_tokens;
      r.cost_usd += a.cost_usd;
      r.estimated_usd += a.estimated_usd;
      r.answers += a.answers;
      r.calls = (r.calls ?? 0) + a.answers;
      by.set(key, r);
    }
    for (const c of this.deps.calls?.() ?? []) {
      if (c.workspaceId !== q.workspaceId) continue;
      const at = c.at.getTime();
      if (at < q.from.getTime() || at >= q.to.getTime()) continue;
      if (q.provider && c.provider !== q.provider) continue;
      const bucket = bucketOf(q.tz, at, q.bucket);
      const key = `${bucket}|${c.engine}|${c.modelId ?? ''}|${c.provider ?? ''}|${c.purpose}`;
      const r = by.get(key) ?? {
        bucket,
        engine: c.engine,
        model_id: c.modelId,
        provider: c.provider,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        cost_usd: 0,
        estimated_usd: 0,
        answers: 0,
        purpose: c.purpose,
        calls: 0,
      };
      r.input_tokens += c.inputTokens;
      r.output_tokens += c.outputTokens;
      r.cached_tokens += c.cachedTokens;
      r.cost_usd += c.costUsd;
      if (c.engine === 'claude_code') r.estimated_usd += c.costUsd;
      r.calls = (r.calls ?? 0) + 1;
      by.set(key, r);
    }
    return [...by.values()];
  }
}

/* ---- history for the calculator and the assistant ------------------------------- */

/** This person's mix per model and provider over the 30 days to `now`. */
export async function usageHistory(
  source: UsageSource,
  workspaceId: string,
  now: number,
): Promise<import('@nvx/contracts').UsageHistory> {
  const rows = await source.rows({
    workspaceId,
    tz: 'UTC',
    bucket: 'day',
    from: new Date(now - 30 * DAY_MS),
    to: new Date(now + 1),
  });
  const by = new Map<string, UsageRow>();
  for (const r of rows) {
    if (!r.model_id) continue;
    const key = `${r.model_id}|${r.provider ?? ''}`;
    const t = by.get(key) ?? {
      ...r,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      cost_usd: 0,
      answers: 0,
    };
    t.input_tokens += r.input_tokens;
    t.output_tokens += r.output_tokens;
    t.cached_tokens += r.cached_tokens;
    t.answers += r.answers;
    by.set(key, t);
  }
  return {
    rows: [...by.values()].map((r) => ({
      model_id: r.model_id as string,
      provider: r.provider ?? null,
      answers: r.answers,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cached_tokens: r.cached_tokens,
      cache_hit_rate: r.input_tokens ? Math.min(1, r.cached_tokens / r.input_tokens) : 0,
      input_share: r.input_tokens + r.output_tokens ? r.input_tokens / (r.input_tokens + r.output_tokens) : 0,
    })),
  };
}

/* ---- Claude Code's part ---------------------------------------------------------- */

/** Threads listed in the Claude Code block. */
export const CLAUDE_CODE_TOP_THREADS = 8;

/**
 * What NVX Ancile measured of Claude Code: today, the last 7 days by day,
 * how much of what it read came from its prompt cache, its busiest
 * threads, and the part of the week brought in from terminal sessions.
 * Measured from its answers here, never the plan's own figures.
 */
export async function claudeCodeUsage(
  source: UsageSource,
  workspaceId: string,
  tz: string,
  now: number,
): Promise<ClaudeCodeUsage> {
  const w = window('week', tz, now);
  const q: UsageQuery = { workspaceId, tz, bucket: 'day', from: w.from, to: w.to };
  const [rows, threads, imported] = await Promise.all([
    source.rows(q),
    source.claudeCodeThreads ? source.claudeCodeThreads(q, CLAUDE_CODE_TOP_THREADS) : Promise.resolve([]),
    source.claudeCodeImported ? source.claudeCodeImported(q) : Promise.resolve({ ...zero(), sessions: 0 }),
  ]);
  const todayKey = w.keys.at(-1);
  const today = zero();
  const week = zero();
  const days = new Map(
    w.keys.map((k) => [k, { start: k, input_tokens: 0, output_tokens: 0, cached_tokens: 0 }]),
  );
  for (const r of rows) {
    if (r.engine !== 'claude_code') continue;
    add(week, r);
    if (r.bucket === todayKey) add(today, r);
    const d = days.get(r.bucket);
    if (d) {
      d.input_tokens += r.input_tokens;
      d.output_tokens += r.output_tokens;
      d.cached_tokens += r.cached_tokens;
    }
  }
  const read = week.input_tokens + week.cached_tokens;
  const rounded = (t: UsageTotals) => ({ ...t, cost_usd: money(t.cost_usd) });
  return {
    tz,
    today: rounded(today),
    week: rounded(week),
    cache_hit_rate: read > 0 ? Math.round((week.cached_tokens / read) * 1000) / 1000 : null,
    days: [...days.values()],
    by_thread: threads.map((t) => ({ ...t, cost_usd: money(t.cost_usd) })),
    imported: { ...rounded(imported), sessions: imported.sessions },
  };
}
