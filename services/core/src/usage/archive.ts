/**
 * ------------------------------------------------------------------
 *  Title    |  Usage archive
 *  Ref      |  DESIGN.md §8 · docs/api.md (Usage) · migration 0038
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keep a purged thread's spend in Settings > Usage and in
 *           |  the month-to-date budget.
 *  How      |  Usage is read from stored messages, so a purge rolls
 *           |  the thread's billed answers up first, in the purge's
 *           |  own transaction, into core.usage_archive: one row per
 *           |  15-minute UTC slot, engine, model and provider. The
 *           |  report adds those rows back. Only what the report
 *           |  counts is archived: Claude Code answers in a deleted
 *           |  thread are not counted today (the session comes back
 *           |  into a new thread), so they are not archived either.
 *  Note     |  15 minutes because every real time zone offset is a
 *           |  multiple of it, so every local day and hour sums the
 *           |  same before and after a purge.
 * ------------------------------------------------------------------
 */

import { CLAUDE_CODE_MODEL_PREFIX, type UsageEngine } from '@nvx/contracts';
import type { Sql } from 'postgres';
import type { MessageRecord } from '../threads/repo';
import { engineOf } from './report';

export const ARCHIVE_SLOT_MS = 15 * 60_000;

/** One rolled-up group of purged answers. */
export interface UsageArchiveRow {
  workspace_id: string;
  /** Start of the 15-minute UTC slot, ISO. */
  bucket_at: string;
  engine: UsageEngine;
  model_id: string | null;
  provider: string | null;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  cost_usd: number;
  estimated_usd: number;
  answers: number;
}

export const slotOf = (iso: string): string =>
  new Date(Math.floor(Date.parse(iso) / ARCHIVE_SLOT_MS) * ARCHIVE_SLOT_MS).toISOString();

/** In memory: roll up messages (of threads about to be purged) into archive rows. */
export function rollUp(
  messages: Iterable<MessageRecord>,
  ctx: { workspaceOf(threadId: string): string | null; runKind(runId: string): string | null },
): UsageArchiveRow[] {
  const by = new Map<string, UsageArchiveRow>();
  for (const m of messages) {
    if (!m.usage) continue;
    const workspace_id = ctx.workspaceOf(m.thread_id);
    if (!workspace_id) continue;
    const engine = engineOf(m.provenance, m.run_id ? ctx.runKind(m.run_id) : null, m.model_id);
    if (engine === 'claude_code') continue;
    const provider = m.usage.served?.provider ?? null;
    const bucket_at = slotOf(m.created_at);
    const key = [workspace_id, bucket_at, engine, m.model_id ?? '', provider ?? ''].join('|');
    const r = by.get(key) ?? {
      workspace_id,
      bucket_at,
      engine,
      model_id: m.model_id ?? null,
      provider,
      input_tokens: 0,
      cached_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      estimated_usd: 0,
      answers: 0,
    };
    r.input_tokens += m.usage.input_tokens;
    r.cached_tokens += m.usage.cached_tokens ?? 0;
    r.output_tokens += m.usage.output_tokens;
    r.cost_usd += m.usage.cost_usd;
    r.answers += 1;
    by.set(key, r);
  }
  return [...by.values()];
}

/** In Postgres: the same roll-up for these threads, inserted before their messages are deleted. */
export async function archiveUsage(sql: Sql, threadIds: string[]): Promise<void> {
  if (threadIds.length === 0) return;
  const cc = `${CLAUDE_CODE_MODEL_PREFIX}%`;
  // The engine rule is report.ts's (PgUsageSource.rows); a Claude Code answer is not archived.
  await sql`
    insert into core.usage_archive
      (workspace_id, bucket_at, engine, model_id, provider, input_tokens, cached_tokens, output_tokens,
       cost_usd, estimated_usd, answers)
    select t.workspace_id,
      to_timestamp(floor(extract(epoch from m.created_at) / 900) * 900),
      case
        when m.provenance ? 'lab' or r.kind = 'agent' then 'lab'
        when r.kind in ('chat_turn', 'flow_try') or m.model_id is not null then 'gateway'
        else 'other'
      end,
      m.model_id,
      m.usage->'served'->>'provider',
      sum(coalesce((m.usage->>'input_tokens')::bigint, 0)),
      sum(coalesce((m.usage->>'cached_tokens')::bigint, 0)),
      sum(coalesce((m.usage->>'output_tokens')::bigint, 0)),
      sum(coalesce((m.usage->>'cost_usd')::numeric, 0)),
      0,
      count(*)::int
    from core.messages m
    join core.threads t on t.id = m.thread_id
    left join core.runs r on r.id = m.run_id
    where m.thread_id = any(${threadIds}) and m.usage is not null
      and not coalesce(m.provenance ? 'claude_code' or r.kind = 'claude_code' or m.model_id like ${cc}, false)
    group by 1, 2, 3, 4, 5`;
}
