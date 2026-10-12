/**
 * ------------------------------------------------------------------
 *  Title    |  Engines: what they remember
 *  Ref      |  docs/engines.md · migration 0019_engines.sql
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Which NVX Ancile compaction each Claude Code session has
 *           |  already been given, which of the notebook's sources a
 *           |  Claude Code thread last saw (core.engine_source_marks,
 *           |  migration 0023), and a notebook's instructions and
 *           |  persona for every engine.
 *  How      |  core.engine_sessions holds one row per session (a
 *           |  session is one branch's place in Claude Code). Notebook
 *           |  instructions sit in core.notebooks.settings under
 *           |  'ancile'; a thread's are in its settings (ThreadRepo).
 *           |  MemoryEngineStore is the same contract for unit tests.
 * ------------------------------------------------------------------
 */

import { AncileInstructions } from '@nvx/contracts';
import type { Sql } from 'postgres';

export interface EngineStore {
  /** Session id → the summary id it was given, for the sessions bound to a thread. */
  seenForThread(workspaceId: string, threadId: string): Promise<Map<string, string>>;
  markSeen(workspaceId: string, sessionId: string, threadId: string, summaryId: string): Promise<void>;
  notebookInstructions(notebookId: string): Promise<AncileInstructions | null>;
  setNotebookInstructions(
    notebookId: string,
    patch: Partial<AncileInstructions>,
  ): Promise<AncileInstructions | null>;
  /** The notebook's sources (id → title) as this thread's Claude Code session last saw them; null: never. */
  sourceMarks(workspaceId: string, threadId: string): Promise<Record<string, string> | null>;
  markSources(workspaceId: string, threadId: string, sources: Record<string, string>): Promise<void>;
}

const parse = (v: unknown): AncileInstructions | null => {
  const p = AncileInstructions.safeParse(v ?? {});
  return p.success ? p.data : null;
};

export class MemoryEngineStore implements EngineStore {
  readonly seen = new Map<string, { threadId: string; summaryId: string }>();
  readonly notebooks = new Map<string, AncileInstructions>();
  /** Notebooks that exist (tests add them); unknown ones answer null. */
  readonly known = new Set<string>();

  async seenForThread(workspaceId: string, threadId: string) {
    const out = new Map<string, string>();
    for (const [k, v] of this.seen)
      if (k.startsWith(`${workspaceId}|`) && v.threadId === threadId)
        out.set(k.slice(workspaceId.length + 1), v.summaryId);
    return out;
  }

  async markSeen(workspaceId: string, sessionId: string, threadId: string, summaryId: string) {
    this.seen.set(`${workspaceId}|${sessionId}`, { threadId, summaryId });
  }

  async notebookInstructions(notebookId: string) {
    if (!this.known.has(notebookId)) return null;
    return this.notebooks.get(notebookId) ?? { instructions: '', persona: '' };
  }

  async setNotebookInstructions(notebookId: string, patch: Partial<AncileInstructions>) {
    if (!this.known.has(notebookId)) return null;
    const next = { ...(this.notebooks.get(notebookId) ?? { instructions: '', persona: '' }), ...patch };
    this.notebooks.set(notebookId, next);
    return next;
  }

  readonly marks = new Map<string, Record<string, string>>();

  async sourceMarks(workspaceId: string, threadId: string) {
    return this.marks.get(`${workspaceId}|${threadId}`) ?? null;
  }

  async markSources(workspaceId: string, threadId: string, sources: Record<string, string>) {
    this.marks.set(`${workspaceId}|${threadId}`, { ...sources });
  }
}

export class PgEngineStore implements EngineStore {
  constructor(private readonly sql: Sql) {}

  async seenForThread(workspaceId: string, threadId: string) {
    const rows = await this.sql<{ session_id: string; seen_summary_id: string | null }[]>`
      select session_id, seen_summary_id from core.engine_sessions
      where workspace_id = ${workspaceId} and thread_id = ${threadId}`;
    return new Map(
      rows.flatMap((r) => (r.seen_summary_id ? [[r.session_id, r.seen_summary_id] as const] : [])),
    );
  }

  async markSeen(workspaceId: string, sessionId: string, threadId: string, summaryId: string) {
    await this.sql`
      insert into core.engine_sessions (workspace_id, session_id, thread_id, seen_summary_id)
      values (${workspaceId}, ${sessionId}, ${threadId}, ${summaryId})
      on conflict (workspace_id, session_id) do update
        set thread_id = excluded.thread_id, seen_summary_id = excluded.seen_summary_id, seen_at = now()`;
  }

  async notebookInstructions(notebookId: string) {
    const rows = await this.sql<{ v: unknown }[]>`
      select settings->'ancile' as v from core.notebooks where id = ${notebookId} and deleted_at is null`;
    return rows.length ? parse(rows[0]?.v) : null;
  }

  async setNotebookInstructions(notebookId: string, patch: Partial<AncileInstructions>) {
    const current = await this.notebookInstructions(notebookId);
    if (!current) return null;
    const next = { ...current, ...patch };
    await this.sql`
      update core.notebooks
        set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{ancile}', ${this.sql.json(next)}),
            updated_at = now()
      where id = ${notebookId}`;
    return next;
  }

  async sourceMarks(workspaceId: string, threadId: string) {
    const rows = await this.sql<{ sources: Record<string, string> }[]>`
      select sources from core.engine_source_marks
      where workspace_id = ${workspaceId} and thread_id = ${threadId}`;
    return rows[0]?.sources ?? null;
  }

  async markSources(workspaceId: string, threadId: string, sources: Record<string, string>) {
    await this.sql`
      insert into core.engine_source_marks (workspace_id, thread_id, sources)
      values (${workspaceId}, ${threadId}, ${this.sql.json(sources)})
      on conflict (workspace_id, thread_id) do update set sources = excluded.sources, updated_at = now()`;
  }
}
