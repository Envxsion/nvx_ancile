/**
 * ------------------------------------------------------------------
 *  Title    |  Bulk thread actions and the Trash
 *  Ref      |  ROADMAP TC3, TC4 · docs/api.md · guard rail GR23
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Move, archive, restore and delete many threads in one
 *           |  call, hand back what each looked like before so Undo
 *           |  is exact, and keep deleted threads in a Trash for 30
 *           |  days.
 *  How      |  A delete only stamps deleted_at: the thread leaves
 *           |  every list and every route, and comes back whole on a
 *           |  restore. Nothing here touches updated_at, so a move or
 *           |  an archive never reorders the rail. A thread that is
 *           |  being answered is left alone and named, whatever the
 *           |  action. The purge removes threads past 30 days, oldest
 *           |  first, and does nothing while any run is active.
 *  Note     |  Emptying the Trash needs `confirm: true`; the Cockpit
 *           |  asks first. Claude Code threads cannot enter a private
 *           |  notebook (docs/scopes.md), so a drop there is refused
 *           |  for them and the rest move.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  type BulkSkip,
  type EmptyTrashResult,
  type ThreadBulkRequest,
  type ThreadBulkResult,
  type ThreadState,
  TRASH_DAYS,
} from '@nvx/contracts';
import { log } from '../obs/logger';
import type { RunStore } from '../runs/engine';
import type { ThreadFields, ThreadRepo } from './repo';

export interface BulkDeps {
  repo: ThreadRepo;
  runs: Pick<RunStore, 'activeForThread'>;
  workspaceId: string;
  /** Moving into a notebook checks it is real; absent: not checked. */
  notebookExists?: (id: string) => Promise<boolean>;
  /** A private notebook keeps Claude Code threads out. */
  notebookPrivate?: (id: string) => Promise<boolean>;
  now?: () => Date;
}

const ACTIVE = ['queued', 'running', 'waiting_approval', 'waiting_compute'] as const;

export function trashConfirmNeeded(): AncileError {
  return new AncileError({
    code: 'trash.confirm_needed',
    title: 'Emptying the Trash needs your confirmation',
    hint: 'This removes every thread in the Trash for good. Confirm in the Trash view, or send confirm: true.',
    status: 400,
    errorClass: 'permanent',
  });
}

const RUNNING = 'Answering now, so it was left where it is. Try again when it finishes.';

/** Apply one bulk action. One thread that cannot change never stops the rest. */
export async function bulkThreads(deps: BulkDeps, req: ThreadBulkRequest): Promise<ThreadBulkResult> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const ids = req.action === 'revert' ? req.states.map((s) => s.id) : [...new Set(req.ids)];
  const current = new Map((await deps.repo.statesOf(deps.workspaceId, ids)).map((s) => [s.id, s] as const));
  const done: ThreadState[] = [];
  const skipped: BulkSkip[] = [];
  const skip = (id: string, title: string, reason: BulkSkip['reason'], hint: string) =>
    skipped.push({ id, title, reason, hint });

  if (deps.notebookExists) {
    // A move goes to a notebook that is there; so does an Undo, which would otherwise put a thread
    // back into a notebook deleted since (and give it that notebook's limits no longer).
    const wanted =
      req.action === 'move'
        ? [req.notebook_id]
        : req.action === 'revert'
          ? req.states
              .filter((s) => s.notebook_id !== current.get(s.id)?.notebook_id)
              .map((s) => s.notebook_id)
          : [];
    for (const nb of new Set(wanted))
      if (nb && !(await deps.notebookExists(nb)))
        throw new AncileError({
          code: 'request.not_found',
          title: 'That notebook was not found',
          hint: 'It may have been deleted. Refresh the view and try again.',
          status: 404,
          errorClass: 'permanent',
        });
  }
  const priv =
    req.action === 'move' && req.notebook_id && deps.notebookPrivate
      ? await deps.notebookPrivate(req.notebook_id)
      : false;

  for (const id of ids) {
    const before = current.get(id);
    if (!before) {
      skip(id, id, 'missing', 'It is gone, so there was nothing to change.');
      continue;
    }
    const trashed = before.deleted_at !== null;
    const wants: ThreadFields | null = (() => {
      switch (req.action) {
        case 'move':
          return before.notebook_id === req.notebook_id ? null : { notebook_id: req.notebook_id };
        case 'archive':
          return before.archived_at ? null : { archived_at: now };
        case 'unarchive':
          return before.archived_at ? { archived_at: null } : null;
        case 'delete':
          return { deleted_at: now };
        case 'restore':
          return trashed ? { deleted_at: null } : null;
        case 'revert': {
          const s = req.states.find((x) => x.id === id) as ThreadState;
          return {
            notebook_id: s.notebook_id,
            archived_at: s.archived_at,
            pinned_at: s.pinned_at,
            updated_at: s.updated_at,
            deleted_at: s.deleted_at,
          };
        }
      }
    })();
    if (!wants) continue;
    // Only the Trash holds a deleted thread; every other action leaves it there.
    if (trashed && req.action !== 'restore' && req.action !== 'revert') {
      skip(id, before.title, 'missing', 'It is in the Trash. Restore it first.');
      continue;
    }
    if (req.action !== 'restore' && (await deps.runs.activeForThread(id)).length > 0) {
      skip(id, before.title, 'running', RUNNING);
      continue;
    }
    if (priv) {
      const t = await deps.repo.getThread(id);
      if (t?.settings.claude_code) {
        skip(id, before.title, 'refused', 'Claude Code threads stay out of private notebooks.');
        continue;
      }
    }
    if (await deps.repo.setFields(deps.workspaceId, id, wants)) done.push(before);
    else skip(id, before.title, 'missing', 'It is gone, so there was nothing to change.');
  }
  log.info(
    { action: req.action, asked: ids.length, done: done.length, skipped: skipped.length },
    'bulk thread action',
  );
  return { done, skipped };
}

export interface PurgeDeps {
  repo: ThreadRepo;
  runs: Pick<RunStore, 'activeForThread' | 'withStatus'>;
  workspaceId: string;
  now?: () => Date;
  /** After a thread is gone for good: its images' files are swept, its flows kept as drafts. */
  afterPurge?: (threadId: string) => Promise<unknown>;
}

export const TRASH_MS = TRASH_DAYS * 86_400_000;

/** True while any run is queued, running or waiting: the purge never runs then. */
export async function anyRunActive(runs: Pick<RunStore, 'withStatus'>): Promise<boolean> {
  for (const s of ACTIVE) if ((await runs.withStatus(s, 1)).length > 0) return true;
  return false;
}

/**
 * Remove threads deleted more than 30 days ago. Returns how many went, or null when a run is
 * active and the purge waited for the next pass.
 */
export async function purgeExpired(deps: PurgeDeps): Promise<number | null> {
  if (await anyRunActive(deps.runs)) return null;
  const cutoff = new Date((deps.now ?? (() => new Date()))().getTime() - TRASH_MS);
  const ids = await deps.repo.trashedBefore(deps.workspaceId, cutoff);
  return (await purgeThreads(deps, ids)).length;
}

/** Empty the Trash now: everything in it, except a thread somehow still running. */
export async function emptyTrash(deps: PurgeDeps, confirm: boolean): Promise<EmptyTrashResult> {
  if (!confirm) throw trashConfirmNeeded();
  const all = (await deps.repo.listTrash(deps.workspaceId)).map((t) => t.id);
  const gone = await purgeThreads(deps, all);
  return { purged: gone.length, kept: all.length - gone.length };
}

async function purgeThreads(deps: PurgeDeps, ids: string[]): Promise<string[]> {
  const free: string[] = [];
  for (const id of ids) if ((await deps.runs.activeForThread(id)).length === 0) free.push(id);
  const gone = await deps.repo.purge(free);
  for (const id of gone) await deps.afterPurge?.(id).catch(() => undefined);
  if (gone.length) log.info({ purged: gone.length }, 'threads purged from the Trash');
  return gone;
}

/**
 * The daily pass: the first soon after start, then every 24 hours. A pass that waited on a
 * run, or failed, tries again in 15 minutes. Returns the function that stops it.
 */
export function scheduleTrashPurge(
  deps: PurgeDeps,
  opts: { firstMs?: number; everyMs?: number; retryMs?: number } = {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const pass = async () => {
    let next = opts.everyMs ?? 86_400_000;
    try {
      if ((await purgeExpired(deps)) === null) next = opts.retryMs ?? 15 * 60_000;
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : String(error) }, 'trash purge failed');
      next = opts.retryMs ?? 15 * 60_000;
    }
    if (!stopped) {
      timer = setTimeout(() => void pass(), next);
      timer.unref?.();
    }
  };
  timer = setTimeout(() => void pass(), opts.firstMs ?? 5 * 60_000);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
