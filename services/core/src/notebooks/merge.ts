/**
 * ------------------------------------------------------------------
 *  Title    |  Merging notebooks
 *  Ref      |  docs/notebooks.md (Merging notebooks) · docs/scopes.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Fold notebook B into notebook A constructively: its
 *           |  threads, notes, sources, notebook memory, flows,
 *           |  Claude Code folders and links join A; instructions are
 *           |  chosen by the person; the scope only ever narrows.
 *  How      |  preview() says everything that would happen, and
 *           |  changes nothing. apply() runs the knowledge service's
 *           |  half (source links move, duplicates by content hash
 *           |  merge into A's copy), then the memory half (B's
 *           |  notebook memory appended to A's through the memory
 *           |  module, one commit), then Core's half in one
 *           |  transaction (merge-store.ts). Each later half failing
 *           |  puts the earlier ones back. undo() reverses all three
 *           |  within the undo window, from the merge's record.
 *  Note     |  The public entry for other parts of NVX Ancile (for
 *           |  example "same repository as …" suggestions) is this
 *           |  class: preview(intoId, fromId) then apply(intoId, req).
 *           |  B's merged sources leave tombstones (reason 'merged',
 *           |  merged_into A's copy), so old citations still resolve.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  type AncileInstructions,
  type KnMergePreview,
  type KnMergeRecord,
  type MergeNotebookRequest,
  MergeNotebookRequest as MergeNotebookRequestSchema,
  type NotebookMerge,
  type NotebookMergePreview,
  type Source,
} from '@nvx/contracts';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

import { entries as memoryEntries, parseMemory } from '../memory/format';
import { notFound } from '../obs/errors';
import { logFor } from '../obs/logger';
import { allPresets, getEffectiveScope, mergeScopes, type ScopeStore } from '../scopes';
import { MergeConflict, type MergeRow, type MergeSideInfo, type MergeStore } from './merge-store';

const log = logFor('notebook-merge');

/** How long a merge can be undone. */
export const MERGE_UNDO_HOURS = 168;

/** The memory module, as a merge uses it (every write is a git commit). */
export interface MergeMemory {
  read(path: string): Promise<{ content: string; version: string } | null>;
  save(
    path: string,
    content: string,
    baseVersion: string | null,
    message: string,
  ): Promise<{ version: string }>;
  revert(version: string): Promise<void>;
}

/** The knowledge service, as a merge uses it. */
export interface MergeKnowledge {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export interface NotebookMergeDeps {
  workspaceId: string;
  store: MergeStore;
  scopes: ScopeStore;
  kn: MergeKnowledge;
  memory?: MergeMemory;
  now?: () => Date;
  undoHours?: number;
}

const enc = encodeURIComponent;

const mergeError = (code: string, title: string, hint: string, status = 422) =>
  new AncileError({ code, title, hint, status, errorClass: 'permanent' });

const sameInstructions = (a: AncileInstructions, b: AncileInstructions) =>
  a.instructions.trim() === b.instructions.trim() && a.persona.trim() === b.persona.trim();

const memoryPath = (slug: string) => `PROJECTS/${slug}.md`;

export class NotebookMergeService {
  constructor(private readonly deps: NotebookMergeDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async sides(intoId: string, fromId: string): Promise<{ into: MergeSideInfo; from: MergeSideInfo }> {
    if (intoId === fromId)
      throw mergeError(
        'notebook.merge_self',
        'A notebook cannot be merged into itself',
        'Choose another notebook to merge.',
      );
    const [into, from] = await Promise.all([this.deps.store.side(intoId), this.deps.store.side(fromId)]);
    if (!into || into.workspace_id !== this.deps.workspaceId) throw notFound('That notebook');
    if (!from || from.workspace_id !== this.deps.workspaceId) throw notFound('The notebook to merge');
    return { into, from };
  }

  private async sourceIds(notebookId: string): Promise<string[]> {
    const r = await this.deps.kn.get<Source[] | { items: Source[] }>(
      `/notebooks/${enc(notebookId)}/sources?workspace_id=${enc(this.deps.workspaceId)}`,
    );
    return (Array.isArray(r) ? r : r.items).map((s) => s.id);
  }

  /** B's notebook memory entries, and the file each side keeps them in. */
  private async memoryOf(into: MergeSideInfo, from: MergeSideInfo) {
    const fromPath = memoryPath(from.slug);
    const intoPath = memoryPath(into.slug);
    if (!this.deps.memory)
      return { fromPath: null, intoPath: null, fromFile: null, intoFile: null, entries: [] };
    const [fromFile, intoFile] = await Promise.all([
      this.deps.memory.read(fromPath).catch(() => null),
      this.deps.memory.read(intoPath).catch(() => null),
    ]);
    const entries = fromFile ? memoryEntries(parseMemory(fromFile.content)) : [];
    return { fromPath: fromFile ? fromPath : null, intoPath, fromFile, intoFile, entries };
  }

  /** Everything a merge of `fromId` into `intoId` would do. Changes nothing. */
  async preview(intoId: string, fromId: string): Promise<NotebookMergePreview> {
    const { into, from } = await this.sides(intoId, fromId);
    return (await this.plan(into, from)).preview;
  }

  private async plan(into: MergeSideInfo, from: MergeSideInfo) {
    const [kn, intoSources, fromSources, intoScope, fromScope, presets, links, mem] = await Promise.all([
      this.deps.kn.get<KnMergePreview>(
        `/notebooks/${enc(into.id)}/merge-preview?from=${enc(from.id)}&workspace_id=${enc(this.deps.workspaceId)}`,
      ),
      this.sourceIds(into.id),
      this.sourceIds(from.id),
      getEffectiveScope(this.deps.scopes, { notebookId: into.id }),
      getEffectiveScope(this.deps.scopes, { notebookId: from.id }),
      allPresets(this.deps.scopes),
      this.deps.store.linkCounts(into.id, from.id),
      this.memoryOf(into, from),
    ]);
    // B's duplicates are read as A's copies once merged, so B's limit names them by A's ids.
    const dupInto = new Map(kn.duplicates.map((d) => [d.id, d.into_id] as const));
    const mapB = (ids: string[]) => [...new Set(ids.map((id) => dupInto.get(id) ?? id))];
    const fromScoped = {
      ...fromScope,
      scope: { ...fromScope.scope, sources: fromScope.scope.sources ? mapB(fromScope.scope.sources) : null },
    };
    const merged = mergeScopes(
      { scope: intoScope, sourceIds: intoSources },
      { scope: fromScoped, sourceIds: mapB(fromSources) },
      presets,
    );
    const intoHasActive = into.flows.some((f) => f.active);
    const warnings: string[] = [];
    if (from.private && !into.private)
      warnings.push(`${from.title} is private, so the merged notebook will be private: local models only.`);
    if (merged.toolPresets.folded)
      warnings.push(
        "Both notebooks chose a tool preset. The merged notebook keeps the first, and the second one's rules are added to its tool limits.",
      );
    if (kn.versions.length)
      warnings.push(
        `${kn.versions.length === 1 ? 'One source looks like another version' : `${kn.versions.length} sources look like other versions`} of a source already here. Both versions are kept.`,
      );
    if (from.grants)
      warnings.push(
        `${from.grants === 1 ? 'One remembered approval' : `${from.grants} remembered approvals`} for ${from.title} are not carried over, so nothing is allowed here that was not before.`,
      );
    const preview: NotebookMergePreview = {
      into: { id: into.id, title: into.title },
      from: { id: from.id, title: from.title },
      threads: from.threads,
      notes: from.notes,
      sources: kn,
      memory: { from_path: mem.fromPath, into_path: mem.intoPath, entries: mem.entries.length },
      flows: from.flows.map((f) => ({ ...f, switched_off: f.active && intoHasActive })),
      instructions: {
        into: into.instructions,
        from: from.instructions,
        same: sameInstructions(into.instructions, from.instructions),
      },
      scope: {
        private: { into: into.private, from: from.private, merged: merged.private },
        changes: merged.changes,
        merged: merged.patch,
      },
      tool_presets: merged.toolPresets,
      folders: { into: into.folders.map((f) => f.cwd), from: from.folders.map((f) => f.cwd) },
      links,
      grants_left_behind: from.grants,
      undo_hours: this.deps.undoHours ?? MERGE_UNDO_HOURS,
      warnings,
    };
    return { preview, merged, mem };
  }

  /** The new contents of A's notebook memory with B's entries added, or null when B has none. */
  private memoryContent(
    into: MergeSideInfo,
    from: MergeSideInfo,
    mem: Awaited<ReturnType<NotebookMergeService['memoryOf']>>,
  ): string | null {
    if (!mem.entries.length) return null;
    const day = this.now().toISOString().slice(0, 10);
    const section = [
      `## Merged from ${from.title} (${day})`,
      '',
      ...mem.entries.map((e) => e.raw.replace(/\s+$/, '')),
      '',
    ].join('\n');
    if (mem.intoFile) {
      const base = mem.intoFile.content;
      return `${base}${base.endsWith('\n') ? '' : '\n'}\n${section}`;
    }
    const title = into.title.replace(/"/g, "'");
    return [
      '---',
      'type: projects',
      'scope: notebook',
      `notebook: "${into.id}"`,
      `title: "${title}"`,
      `updated: "${day}"`,
      '---',
      `# ${into.title}`,
      '',
      section,
    ].join('\n');
  }

  /**
   * Merge `req.from_id` into `intoId`. All of it, or (if any part fails)
   * none of it: each half that already ran is put back.
   */
  async apply(intoId: string, request: MergeNotebookRequest): Promise<NotebookMerge> {
    const req = MergeNotebookRequestSchema.parse(request);
    const { into, from } = await this.sides(intoId, req.from_id);
    const { preview, merged, mem } = await this.plan(into, from);
    const instructions: AncileInstructions =
      req.instructions.choice === 'into'
        ? into.instructions
        : req.instructions.choice === 'from'
          ? from.instructions
          : { instructions: req.instructions.instructions, persona: req.instructions.persona };
    const id = `nbm_${ulid()}`;
    const kn = await this.deps.kn.post<KnMergeRecord>(`/notebooks/${enc(into.id)}/merge`, {
      from_id: from.id,
      workspace_id: this.deps.workspaceId,
    });
    const knUndo = () =>
      this.deps.kn
        .post(`/notebooks/${enc(into.id)}/merge/undo`, {
          from_id: from.id,
          workspace_id: this.deps.workspaceId,
          record: kn,
        })
        .catch((err: unknown) =>
          log.error({ err, merge: id }, 'the sources could not be put back after a failed merge'),
        );
    let commit: string | null = null;
    try {
      const content = this.memoryContent(into, from, mem);
      if (content !== null && this.deps.memory && mem.intoPath)
        commit = (
          await this.deps.memory.save(
            mem.intoPath,
            content,
            mem.intoFile?.version ?? null,
            `merged notebook memory from ${from.title}`,
          )
        ).version;
    } catch (err) {
      await knUndo();
      throw err;
    }
    try {
      const row = await this.deps.store.apply({
        id,
        workspace_id: this.deps.workspaceId,
        into,
        from,
        scope: { patch: merged.patch, private: merged.private },
        instructions,
        kn,
        memory_commit: commit,
        tombstones: kn.merged
          .filter((m) => m.deleted)
          .map((m) => ({ source_id: m.source_id, title: m.title, kind: m.kind, merged_into: m.into_id })),
        undo_until: new Date(this.now().getTime() + preview.undo_hours * 3_600_000),
        scope_narrowed: merged.changes.filter((c) => c.narrows_into).map((c) => c.field),
      });
      log.info(
        {
          merge: id,
          threads: row.record.threads.length,
          sources: kn.moved.length,
          deduplicated: kn.merged.length,
        },
        'notebooks merged',
      );
      return this.view(row);
    } catch (err) {
      await knUndo();
      if (commit) await this.deps.memory?.revert(commit).catch(() => undefined);
      if (err instanceof MergeConflict)
        throw mergeError(
          'notebook.merge_conflict',
          'One of the notebooks changed while merging',
          'Nothing was merged. Look at both notebooks again and try once more.',
          409,
        );
      throw err;
    }
  }

  /** Put a merge back, within its undo window. */
  async undo(mergeId: string): Promise<NotebookMerge> {
    const row = await this.deps.store.get(mergeId);
    if (!row || row.workspace_id !== this.deps.workspaceId) throw notFound('That merge');
    if (row.undone_at)
      throw mergeError('notebook.merge_undone', 'This merge was already undone', 'Nothing to do.', 409);
    if (this.now().getTime() > Date.parse(row.undo_until))
      throw mergeError(
        'notebook.merge_expired',
        'This merge can no longer be undone',
        `A merge can be undone for ${Math.round((this.deps.undoHours ?? MERGE_UNDO_HOURS) / 24)} days. Move threads and sources back by hand instead.`,
        409,
      );
    await this.deps.kn.post(`/notebooks/${enc(row.into_id)}/merge/undo`, {
      from_id: row.from_id,
      workspace_id: this.deps.workspaceId,
      record: row.record.kn,
    });
    let done: MergeRow;
    try {
      done = await this.deps.store.undo(mergeId);
    } catch (err) {
      // Core could not be put back: the sources go back to how the merge left them.
      await this.deps.kn
        .post<KnMergeRecord>(`/notebooks/${enc(row.into_id)}/merge`, {
          from_id: row.from_id,
          workspace_id: this.deps.workspaceId,
        })
        .catch(() => undefined);
      if (err instanceof MergeConflict)
        throw mergeError(
          'notebook.merge_conflict',
          'This merge cannot be undone now',
          'The notebook it was merged into has been deleted. Restore it first.',
          409,
        );
      throw err;
    }
    if (row.record.memory_commit)
      await this.deps.memory
        ?.revert(row.record.memory_commit)
        .catch((err: unknown) =>
          log.warn(
            { err, merge: mergeId },
            'the notebook memory could not be put back; revert it from Memory → History',
          ),
        );
    return this.view(done);
  }

  async list(notebookId: string): Promise<NotebookMerge[]> {
    return (await this.deps.store.list(notebookId))
      .filter((r) => r.workspace_id === this.deps.workspaceId)
      .map((r) => this.view(r));
  }

  view(row: MergeRow): NotebookMerge {
    const r = row.record;
    return {
      id: row.id,
      into_id: row.into_id,
      from_id: row.from_id,
      from_title: row.from_title,
      merged_at: row.merged_at,
      undo_until: row.undo_until,
      undone_at: row.undone_at,
      can_undo: !row.undone_at && this.now().getTime() <= Date.parse(row.undo_until),
      counts: {
        threads: r.threads.length,
        notes: r.notes.length,
        sources_moved: r.kn.moved.length,
        sources_deduplicated: r.kn.merged.length,
        flows: r.flows.length,
        folders: r.folders.length,
        links: r.links.filter((l) => l.action === 'retargeted').length,
      },
      scope_narrowed: r.scope_narrowed as NotebookMerge['scope_narrowed'],
    };
  }
}
