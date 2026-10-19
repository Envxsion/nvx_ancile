/**
 * ------------------------------------------------------------------
 *  Title    |  Bulk thread actions, Trash and read state
 *  Ref      |  ROADMAP TC3, TC4, RA1 · docs/api.md · guard rail GR23
 *  ID       |  contracts
 * ------------------------------------------------------------------
 *  Purpose  |  Moving, archiving and deleting many threads at once,
 *           |  with an Undo that restores exactly; the Trash that
 *           |  deleted threads wait in for 30 days; and the read
 *           |  state that tells the rail which threads have an
 *           |  answer you have not seen.
 *  How      |  One endpoint takes an action and ids. It answers with
 *           |  what it did (the state each thread had before, which
 *           |  is all Undo needs) and what it left alone, with the
 *           |  reason: a thread being answered is never changed.
 *           |  Undo is the same endpoint with action "revert" and
 *           |  those states.
 *  Note     |  A delete is a move to the Trash: nothing is lost for
 *           |  30 days. Only emptying the Trash, or the daily purge
 *           |  after 30 days, removes a thread for good.
 * ------------------------------------------------------------------
 */

import { z } from 'zod';

/** Days a deleted thread waits in the Trash before the daily purge removes it. */
export const TRASH_DAYS = 30;
/** Most threads one bulk action takes. */
export const BULK_MAX = 500;

const Ids = z.array(z.string().min(1).max(100)).min(1).max(BULK_MAX);

/** Everything a bulk action can change on a thread, exactly as it was. */
export const ThreadState = z.object({
  id: z.string(),
  title: z.string(),
  notebook_id: z.string().nullable(),
  archived_at: z.string().nullable(),
  pinned_at: z.string().nullable(),
  /** Moves and archives do not touch it, so order in the rail survives an Undo. */
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});
export type ThreadState = z.infer<typeof ThreadState>;

/** POST /threads/bulk */
export const ThreadBulkRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('move'), ids: Ids, notebook_id: z.string().nullable() }).strict(),
  z.object({ action: z.enum(['archive', 'unarchive', 'delete', 'restore']), ids: Ids }).strict(),
  z.object({ action: z.literal('revert'), states: z.array(ThreadState).min(1).max(BULK_MAX) }).strict(),
]);
export type ThreadBulkRequest = z.infer<typeof ThreadBulkRequest>;

/** Why a thread was left alone. */
export const BulkSkipReason = z.enum(['running', 'missing', 'refused']);
export type BulkSkipReason = z.infer<typeof BulkSkipReason>;

export const BulkSkip = z.object({
  id: z.string(),
  title: z.string(),
  reason: BulkSkipReason,
  /** In words: "Answering now", "Claude Code threads stay out of private notebooks". */
  hint: z.string(),
});
export type BulkSkip = z.infer<typeof BulkSkip>;

export const ThreadBulkResult = z.object({
  /** The state each changed thread had before: pass them back as a revert to undo. */
  done: z.array(ThreadState),
  skipped: z.array(BulkSkip),
});
export type ThreadBulkResult = z.infer<typeof ThreadBulkResult>;

/** A deleted thread in the Trash. */
export const TrashItem = z.object({
  id: z.string(),
  title: z.string(),
  notebook_id: z.string().nullable(),
  deleted_at: z.string(),
  /** When the daily purge removes it for good. */
  purge_at: z.string(),
});
export type TrashItem = z.infer<typeof TrashItem>;

/** GET /threads/trash */
export const TrashList = z.object({ items: z.array(TrashItem), retention_days: z.number().int() });
export type TrashList = z.infer<typeof TrashList>;

/** POST /threads/trash/empty: removes everything in the Trash for good. Needs the confirm. */
export const EmptyTrashRequest = z.object({ confirm: z.boolean() }).strict();
export type EmptyTrashRequest = z.infer<typeof EmptyTrashRequest>;

export const EmptyTrashResult = z.object({ purged: z.number().int(), kept: z.number().int() });
export type EmptyTrashResult = z.infer<typeof EmptyTrashResult>;
