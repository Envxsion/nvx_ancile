/**
 * ------------------------------------------------------------------
 *  Title    |  Purge plan
 *  Ref      |  DESIGN.md §8 · ROADMAP TC3 (Trash) · docs/api.md (Trash)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Say, table by table, what happens to the rows that point
 *           |  at a thread when the Trash purge removes it for good.
 *  How      |  PURGE_PLAN is a reviewed list, in the order it runs:
 *           |  delete (the thread's own content), detach (keep the
 *           |  row, null the reference), keep-summary (roll the facts
 *           |  up first, then delete: usage) or keep (a plain id with
 *           |  no foreign key, left as it is). purgeThreads() runs it
 *           |  inside the caller's transaction. A test reads the
 *           |  drizzle schema and the migrations and fails when a
 *           |  table that points at threads, messages, branches or
 *           |  runs is missing here, so a new table is never wiped by
 *           |  default and never forgotten.
 *  Note     |  Nothing here is discovered from the database. Memory
 *           |  proposals carry their thread inside evidence (jsonb, no
 *           |  foreign key) and M3 shows "learned in a thread that was
 *           |  deleted", so they are not touched.
 * ------------------------------------------------------------------
 */

import type { Sql } from 'postgres';
import { archiveUsage } from '../usage/archive';

export type PurgeAction = 'delete' | 'detach' | 'keep-summary' | 'keep';

/** How a table's rows are found from the thread ids being purged. */
export type PurgeBy = 'thread' | 'message' | 'run' | 'factcheck' | 'raw';

export interface PurgeEntry {
  table: string;
  action: PurgeAction;
  by: PurgeBy;
  /** The column that holds the id (not used for 'raw'). */
  column: string;
  /** detach: the columns set to null. */
  nulls?: string[];
  /** delete: rows that match this are detached instead (the `nulls` columns), never deleted. */
  except?: string;
  /** by 'raw': the whole predicate, with the thread ids as $1. */
  where?: string;
  why: string;
}

export const PURGE_PLAN: readonly PurgeEntry[] = [
  // ---- detach: history that must outlive the thread ----
  {
    table: 'core.approvals',
    action: 'detach',
    by: 'thread',
    column: 'thread_id',
    nulls: ['thread_id'],
    why: 'The audit of what was asked and decided. thread_id is only context, so it is cleared and the row stays.',
  },
  {
    table: 'core.auto_plans',
    action: 'detach',
    by: 'thread',
    column: 'thread_id',
    nulls: ['thread_id'],
    why: 'An approved Auto plan is a permission record; the session key stays, the thread link is cleared.',
  },
  // ---- delete: the thread's own content, children before parents ----
  {
    table: 'core.claims',
    action: 'delete',
    by: 'factcheck',
    column: 'factcheck_id',
    why: "Claims of a fact-check of the thread's answers; they mean nothing without the answer.",
  },
  {
    table: 'core.factchecks',
    action: 'delete',
    by: 'message',
    column: 'message_id',
    why: "A fact-check is of one of the thread's messages (foreign key to messages).",
  },
  {
    table: 'core.summaries',
    action: 'delete',
    by: 'thread',
    column: 'thread_id',
    why: 'TLDRs and compactions of this thread (foreign keys to the thread and its messages).',
  },
  {
    table: 'core.branches',
    action: 'delete',
    by: 'thread',
    column: 'thread_id',
    why: "Names and colours over this thread's messages (foreign keys to the thread and its messages).",
  },
  {
    table: 'core.drafts',
    action: 'delete',
    by: 'thread',
    column: 'thread_id',
    why: 'Unsent text in this thread.',
  },
  {
    table: 'core.prompt_epochs',
    action: 'delete',
    by: 'thread',
    column: 'thread_id',
    why: 'The exact prompt prefixes sent in this thread (system text, tools, pinned memory): its content.',
  },
  {
    table: 'core.engine_source_marks',
    action: 'delete',
    by: 'thread',
    column: 'thread_id',
    why: 'Per-thread cache state for which sources were sent.',
  },
  {
    table: 'core.artifact_settings',
    action: 'delete',
    by: 'thread',
    column: 'thread_id',
    why: "Settings of this thread's artifacts.",
  },
  {
    table: 'core.interpreter_figures',
    action: 'delete',
    by: 'thread',
    column: 'thread_id',
    why: "Figures drawn in this thread's interpreter: its content. Its cost is in messages.",
  },
  {
    table: 'core.images',
    action: 'delete',
    by: 'thread',
    column: 'thread_id',
    why: 'A row is one use of an image in this thread, not a shared asset. The bytes are shared by hash and the image sweep removes any file no row names.',
  },
  {
    table: 'core.claude_code_unknown_entries',
    action: 'delete',
    by: 'thread',
    column: 'thread_id',
    why: "Raw transcript entries of this thread's Claude Code session: its content.",
  },
  {
    table: 'core.claude_code_sessions',
    action: 'delete',
    by: 'thread',
    column: 'thread_id',
    why: 'Maps a Claude Code session to this thread (thread_id is required). With no thread, a sync brings the session back in as a new one.',
  },
  {
    table: 'core.engine_sessions',
    action: 'delete',
    by: 'thread',
    column: 'thread_id',
    why: 'Maps an engine session to this thread (thread_id is required); useless without it.',
  },
  {
    table: 'core.thread_send_locks',
    action: 'delete',
    by: 'thread',
    column: 'thread_id',
    why: 'A lock on sending in this thread.',
  },
  {
    table: 'core.context_links',
    action: 'delete',
    by: 'raw',
    column: 'from_id',
    where: "(from_kind = 'thread' and from_id = any($1)) or (to_kind = 'thread' and to_id = any($1))",
    why: 'A link to or from a thread that no longer exists points at nothing.',
  },
  {
    table: 'core.run_events',
    action: 'delete',
    by: 'run',
    column: 'run_id',
    why: "The event stream of the thread's runs (run_id is plain text, no foreign key): content.",
  },
  {
    table: 'core.run_steps',
    action: 'delete',
    by: 'run',
    column: 'run_id',
    why: "Tool inputs and outputs of the thread's runs (foreign key to runs): content.",
  },
  {
    table: 'core.runs',
    action: 'delete',
    by: 'thread',
    column: 'thread_id',
    nulls: ['thread_id', 'message_id', 'checkpoint'],
    except: 'exists (select 1 from core.approvals a where a.run_id = core.runs.id)',
    why: "The thread's runs. A run an approval still points at (foreign key, the audit) stays, with the thread, message and checkpoint cleared.",
  },
  // ---- keep-summary: spend ----
  {
    table: 'core.messages',
    action: 'keep-summary',
    by: 'thread',
    column: 'thread_id',
    why: "The thread's own content. Before it goes, its billed answers are rolled up into core.usage_archive, which the Usage report and the month-to-date budget read, so past spend does not change.",
  },
  // ---- chat imports (SU1) ----
  {
    table: 'core.chat_import_items',
    action: 'delete',
    by: 'thread',
    column: 'thread_id',
    why: 'The note that a conversation from ChatGPT, Claude or Open WebUI became this thread. Once the thread is gone for good, the same export may bring that conversation in again.',
  },
  // ---- keep: plain ids with no foreign key ----
  {
    table: 'core.flow_decisions',
    action: 'keep',
    by: 'thread',
    column: 'thread_id',
    why: 'Flow history (the confidence heat-map and close calls). thread_id and message_id are plain text and required.',
  },
  {
    table: 'core.decisions',
    action: 'keep',
    by: 'run',
    column: 'run_id',
    why: 'The permission decision audit; run_id is plain text.',
  },
  {
    table: 'core.notes',
    action: 'keep',
    by: 'message',
    column: 'from_message_id',
    why: "A note is the person's own content; where it came from is only a pointer.",
  },
  // ---- the thread itself, last ----
  {
    table: 'core.threads',
    action: 'delete',
    by: 'raw',
    column: 'id',
    where: 'id = any($1)',
    why: 'The thread. It goes only once every row above has been dealt with.',
  },
];

/** What each entry selects, with the thread ids as $1. */
function predicate(e: PurgeEntry): string {
  const msgs = 'select id from core.messages where thread_id = any($1)';
  switch (e.by) {
    case 'thread':
      return `${e.column} = any($1)`;
    case 'message':
      return `${e.column} in (${msgs})`;
    case 'run':
      return `${e.column} in (select id from core.runs where thread_id = any($1))`;
    case 'factcheck':
      return `${e.column} in (select id from core.factchecks where message_id in (${msgs}))`;
    case 'raw':
      return e.where as string;
  }
}

/**
 * Run the plan for threads already known to be deleted and idle. Call it inside the transaction
 * that also decides which threads these are.
 */
export async function purgeThreads(tx: Sql, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (const e of PURGE_PLAN) {
    if (e.action === 'keep') continue;
    const where = predicate(e);
    if (e.action === 'keep-summary') await archiveUsage(tx, ids);
    if (e.action === 'detach' || e.except) {
      const set = (e.nulls ?? []).map((c) => `${c} = null`).join(', ');
      const guard = e.except ? ` and ${e.except}` : '';
      await tx.unsafe(`update ${e.table} set ${set} where ${where}${guard}`, [ids as never]);
    }
    if (e.action === 'detach') continue;
    const rest = e.except ? ` and not (${e.except})` : '';
    await tx.unsafe(`delete from ${e.table} where ${where}${rest}`, [ids as never]);
  }
}
