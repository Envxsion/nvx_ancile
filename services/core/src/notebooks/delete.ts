/**
 * ------------------------------------------------------------------
 *  Title    |  Deleting a notebook
 *  Ref      |  docs/notebooks.md (Deleting a notebook) · docs/api.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Take a notebook away without leaving anything that
 *           |  pointed at it half done. Two ways: the plain delete
 *           |  (its threads and sources stay in the workspace) and
 *           |  "with everything in it" (its threads go to the Trash
 *           |  for 30 days and the sources no other notebook uses are
 *           |  deleted), which Core does whole so the Cockpit cannot
 *           |  get a page of threads wrong.
 *  How      |  With everything, Core reads first and changes second:
 *           |  every thread of the notebook (live and archived), any
 *           |  that is answering (409, nothing changed), and the
 *           |  sources of this and every other notebook (Knowledge
 *           |  must answer, 503 and nothing changed otherwise). Then:
 *           |  threads to the Trash (reversible, and undone again if
 *           |  one started answering meanwhile), sources only this
 *           |  notebook used deleted (a tombstone after each delete
 *           |  succeeds), the rest unlinked, its checked claims
 *           |  cleared, its flows kept as drafts, its Claude Code
 *           |  folder marked dismissed, and the notebook removed last,
 *           |  in one database transaction that also moves its
 *           |  privacy onto its threads and takes its notes, links,
 *           |  scope rows and grants (notebooks/repo.ts).
 *  Note     |  The plain delete stays tolerant: a Knowledge that does
 *           |  not answer must not stop you deleting a notebook.
 *           |  Knowledge only soft-deletes a source today; its files,
 *           |  chunks and embeddings stay until the purge exists.
 *           |  TODO(phase-6): purge a deleted source's files, chunks
 *           |  and embeddings in Knowledge.
 * ------------------------------------------------------------------
 */

import { AncileError, type DeleteNotebookResult, type Source } from '@nvx/contracts';
import type { FlowStore } from '../flows/store';
import type { KnowledgeClient } from '../knowledge/client';
import type { TombstoneStore } from '../knowledge/integrity';
import { log } from '../obs/logger';
import type { ProRemoval } from '../pro/types';
import type { RunStore } from '../runs/engine';
import { bulkThreads } from '../threads/bulk';
import type { ThreadRepo } from '../threads/repo';
import type { NotebookRecord, NotebookRepo } from './repo';

export interface NotebookDeleteDeps {
  workspaceId: string;
  notebooks: NotebookRepo;
  threads: ThreadRepo;
  kn: KnowledgeClient;
  /** A thread that is answering stops "with everything in it". Absent: not checked. */
  runs?: Pick<RunStore, 'activeForThread'>;
  /** Deleting a notebook keeps its flows as inactive workspace drafts. */
  flowStore?: Pick<FlowStore, 'orphan'>;
  /** Its checked claims go with the notebook, the ones it shared included (SI1). */
  verdictCache?: Pick<import('../factcheck/cache').VerdictCache, 'clear'>;
  /** A deleted source leaves its name behind, for answers that cited it (track G). */
  tombstones?: TombstoneStore;
  /** A Claude Code folder bound to the notebook is marked dismissed so a sync does not bring it back. */
  claudeCode?: { dismissNotebook(notebookId: string): Promise<unknown> };
  /** Pro (and anything else keeping copies) is told what is gone. Never allowed to fail the delete. */
  gone?: (e: ProRemoval) => Promise<unknown> | unknown;
  now?: () => Date;
}

const enc = encodeURIComponent;

/** A notebook's sources. Knowledge lists as a bare array; the API always answers { items }. */
export async function sourcesOf(kn: Pick<KnowledgeClient, 'get'>, notebookId: string): Promise<Source[]> {
  const r = await kn.get<Source[] | { items: Source[] }>(`/notebooks/${enc(notebookId)}/sources`);
  return Array.isArray(r) ? r : (r.items ?? []);
}

const answering = (titles: string[]) =>
  new AncileError({
    code: 'notebook.delete_blocked',
    title:
      titles.length === 1
        ? 'A thread in this notebook is answering'
        : `${titles.length} threads in this notebook are answering`,
    hint: 'Stop them or wait for them to finish, then delete the notebook again. Nothing was changed.',
    detail: titles.map((t) => `“${t}”`).join(', '),
    status: 409,
    errorClass: 'permanent',
    context: { threads: titles },
  });

const knowledgeDown = (cause: unknown) =>
  new AncileError({
    code: 'notebook.delete_needs_knowledge',
    title: 'The sources could not be checked, so nothing was deleted',
    hint: 'Deleting a notebook with its contents needs the knowledge service. Check Health, then try again. Nothing was changed.',
    status: 503,
    errorClass: 'transient',
    retryable: true,
    cause,
  });

/** Tell whoever keeps copies; the delete has happened, so a failure here is logged and nothing more. */
async function announce(deps: NotebookDeleteDeps, events: ProRemoval[]) {
  if (!deps.gone) return;
  for (const e of events) {
    try {
      await deps.gone(e);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), kind: e.kind },
        'removal notice failed',
      );
    }
  }
}

export class NotebookDeleter {
  constructor(private readonly deps: NotebookDeleteDeps) {}

  /** A source about to go: its name, so answers that cited it can still say what it was. */
  private async buryAfter(s: Source) {
    const { kn, tombstones, workspaceId } = this.deps;
    await kn.del(`/sources/${enc(s.id)}`);
    await tombstones?.record({
      source_id: s.id,
      workspace_id: workspaceId,
      title: s.title,
      kind: s.kind,
      reason: 'deleted',
      merged_into: null,
    });
  }

  /** The plain delete: threads and sources stay in the workspace; only this notebook's links go. */
  async plain(n: NotebookRecord): Promise<void> {
    const { kn, notebooks, flowStore, verdictCache, claudeCode } = this.deps;
    const linked = await sourcesOf(kn, n.id).catch(() => [] as Source[]);
    await Promise.all(
      linked.map((s) => kn.del(`/notebooks/${enc(n.id)}/sources/${enc(s.id)}`).catch(() => undefined)),
    );
    await claudeCode?.dismissNotebook(n.id);
    if (!(await notebooks.remove(n.id))) return;
    // A flow is work: it outlives its notebook, as an inactive workspace draft.
    await flowStore?.orphan('notebook', n.id);
    await verdictCache?.clear(n.id);
    await announce(this.deps, [{ kind: 'notebook', id: n.id }]);
  }

  /** "With everything in it": all or nothing as far as it can be, and counted. */
  async withContents(n: NotebookRecord): Promise<DeleteNotebookResult> {
    const { kn, notebooks, threads, runs, flowStore, verdictCache, claudeCode, workspaceId } = this.deps;

    /* ---- Read everything first; change nothing until it is all in hand. ---- */
    const all = await threads.inNotebook(workspaceId, n.id);
    const live = all.filter((t) => t.deleted_at === null);
    if (runs) {
      const busy: string[] = [];
      for (const t of live) if ((await runs.activeForThread(t.id)).length > 0) busy.push(t.title);
      if (busy.length) throw answering(busy);
    }
    let linked: Source[];
    let alone: Source[];
    try {
      linked = await sourcesOf(kn, n.id);
      const used = new Set<string>();
      for (const o of (await notebooks.list(workspaceId)).filter((o) => o.id !== n.id))
        for (const s of await sourcesOf(kn, o.id)) used.add(s.id);
      alone = linked.filter((s) => !used.has(s.id));
    } catch (err) {
      throw knowledgeDown(err);
    }

    /* ---- Threads to the Trash: reversible, so it goes before anything that is not. ---- */
    const { done, skipped } = await bulkThreads(
      {
        repo: threads,
        runs: runs ?? { activeForThread: async () => [] },
        workspaceId,
        ...(this.deps.now && { now: this.deps.now }),
      },
      { action: 'delete', ids: live.map((t) => t.id) },
    );
    if (skipped.length) {
      // One started answering between the check and the move: put back what moved and stop.
      for (const before of done) await threads.setFields(workspaceId, before.id, { deleted_at: null });
      throw answering(skipped.map((s) => s.title));
    }

    /* ---- Sources only this notebook used, then the unlinking of the rest. ---- */
    const events: ProRemoval[] = [];
    for (const s of alone) {
      await this.buryAfter(s);
      events.push({ kind: 'source', id: s.id });
    }
    const aloneIds = new Set(alone.map((s) => s.id));
    for (const s of linked.filter((x) => !aloneIds.has(x.id)))
      await kn.del(`/notebooks/${enc(n.id)}/sources/${enc(s.id)}`);

    /* ---- Its checked claims and flows, its folder, then the notebook itself, last. ---- */
    await verdictCache?.clear(n.id);
    await flowStore?.orphan('notebook', n.id);
    await claudeCode?.dismissNotebook(n.id);
    if (!(await notebooks.remove(n.id))) {
      throw new AncileError({
        code: 'request.not_found',
        title: 'That notebook was not found',
        hint: 'It was deleted while this ran. Refresh the view.',
        status: 404,
        errorClass: 'permanent',
      });
    }
    events.push({ kind: 'notebook', id: n.id });
    await announce(this.deps, events);
    log.info(
      {
        notebook_id: n.id,
        threads: done.length,
        sources_deleted: alone.length,
        sources_kept: linked.length - alone.length,
      },
      'notebook deleted with its contents',
    );
    return {
      threads_trashed: done.length,
      sources_deleted: alone.length,
      sources_kept: linked.length - alone.length,
    };
  }
}
