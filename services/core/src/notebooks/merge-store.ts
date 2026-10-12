/**
 * ------------------------------------------------------------------
 *  Title    |  Notebook merge at rest
 *  Ref      |  docs/notebooks.md (Merging notebooks) · migrations/0031
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Read what each side of a merge holds, apply the Core
 *           |  half of a merge in one transaction, and reverse it from
 *           |  the record it kept.
 *  How      |  apply(): threads, notes, flows, Claude Code folders and
 *           |  context links move from B to A; B's "sent before it
 *           |  became private" history is copied to A; A takes the
 *           |  merged scope and instructions; tombstones are written
 *           |  for B's sources merged into A's copies; B is soft-
 *           |  deleted with merged_into; one core.notebook_merges row
 *           |  keeps what was there before. undo(): the same in
 *           |  reverse, in one transaction, from that row.
 *  Note     |  B's remembered approvals (grants) are left with B: moving
 *           |  them would widen what A allows. MemoryMergeStore models
 *           |  the same rows for the unit tests and the harness.
 * ------------------------------------------------------------------
 */

import type { AncileInstructions, KnMergeRecord, ScopePatch } from '@nvx/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { pgSafe } from '../db/json';
import type { MemoryTombstoneStore } from '../knowledge/integrity';
import type { LinkRecord, MemoryLinkStore } from '../links/store';
import type { MemoryScopeStore } from '../scopes/store';

export interface MergeSideInfo {
  id: string;
  workspace_id: string;
  title: string;
  slug: string;
  private: boolean;
  patch: ScopePatch;
  /** Whether the scope row existed (undo puts back "no row"). */
  has_scope_row: boolean;
  instructions: AncileInstructions;
  threads: { id: string; title: string; cwd: string | null }[];
  notes: { id: string; title: string }[];
  flows: { id: string; name: string; active: boolean }[];
  folders: { cwd_key: string; cwd: string }[];
  /** Remembered approvals scoped to this notebook. */
  grants: number;
}

export interface MergeTombstone {
  source_id: string;
  title: string;
  kind: string | null;
  merged_into: string;
}

export interface ApplyPlan {
  id: string;
  workspace_id: string;
  into: MergeSideInfo;
  from: MergeSideInfo;
  scope: { patch: ScopePatch; private: boolean };
  instructions: AncileInstructions;
  kn: KnMergeRecord;
  memory_commit: string | null;
  tombstones: MergeTombstone[];
  undo_until: Date;
  /** Scope fields that became narrower for A, kept for history. */
  scope_narrowed: string[];
}

/** Everything undo needs, stored as core.notebook_merges.record. */
export interface MergeRecordData {
  threads: string[];
  notes: string[];
  flows: { id: string; was_active: boolean }[];
  folders: string[];
  links: { before: LinkRecord; action: 'retargeted' | 'dropped' }[];
  shared_history: string[];
  into_before: {
    patch: ScopePatch;
    has_scope_row: boolean;
    private: boolean;
    instructions: AncileInstructions;
  };
  kn: KnMergeRecord;
  memory_commit: string | null;
  tombstones: string[];
  scope_narrowed: string[];
}

export interface MergeRow {
  id: string;
  workspace_id: string;
  into_id: string;
  from_id: string;
  from_title: string;
  record: MergeRecordData;
  merged_at: string;
  undo_until: string;
  undone_at: string | null;
}

export interface MergeStore {
  side(notebookId: string): Promise<MergeSideInfo | undefined>;
  /** Links to or from B that will point at A, and those that would point at A itself. */
  linkCounts(intoId: string, fromId: string): Promise<{ retarget: number; dropped: number }>;
  /** The Core half of a merge, all or nothing. Throws if either notebook changed state meanwhile. */
  apply(plan: ApplyPlan): Promise<MergeRow>;
  /** Reverse a merge from its record, all or nothing. */
  undo(id: string): Promise<MergeRow>;
  get(id: string): Promise<MergeRow | undefined>;
  /** Merges into or out of a notebook, newest first. */
  list(notebookId: string): Promise<MergeRow[]>;
}

export class MergeConflict extends Error {}

const EMPTY_INSTRUCTIONS: AncileInstructions = { instructions: '', persona: '' };

function instructionsOf(settings: unknown): AncileInstructions {
  const v = (settings as { ancile?: Partial<AncileInstructions> } | null)?.ancile;
  return {
    instructions: typeof v?.instructions === 'string' ? v.instructions : '',
    persona: typeof v?.persona === 'string' ? v.persona : '',
  };
}

/** Where a link's ends land when B becomes A. */
function retarget(l: LinkRecord, intoId: string, fromId: string) {
  const swap = (kind: string, id: string) => (kind === 'notebook' && id === fromId ? intoId : id);
  return { ...l, from_id: swap(l.from_kind, l.from_id), to_id: swap(l.to_kind, l.to_id) };
}

const touches = (l: LinkRecord, nb: string) =>
  (l.from_kind === 'notebook' && l.from_id === nb) || (l.to_kind === 'notebook' && l.to_id === nb);

/* ---- Postgres ------------------------------------------------------------ */

interface RowShape {
  id: string;
  workspace_id: string;
  into_id: string;
  from_id: string;
  from_title: string;
  record: MergeRecordData | string;
  merged_at: Date;
  undo_until: Date;
  undone_at: Date | null;
}

const fromRow = (r: RowShape): MergeRow => ({
  ...r,
  record: typeof r.record === 'string' ? (JSON.parse(r.record) as MergeRecordData) : r.record,
  merged_at: r.merged_at.toISOString(),
  undo_until: r.undo_until.toISOString(),
  undone_at: r.undone_at ? r.undone_at.toISOString() : null,
});

interface LinkRowPg extends Omit<LinkRecord, 'created_at'> {
  created_at: Date;
}

export class PgMergeStore implements MergeStore {
  constructor(private readonly sql: Sql) {}

  async side(notebookId: string): Promise<MergeSideInfo | undefined> {
    const [nb] = await this.sql<
      { id: string; workspace_id: string; title: string; slug: string; private: boolean; settings: unknown }[]
    >`select id, workspace_id, title, slug, private, settings from core.notebooks
      where id = ${notebookId} and deleted_at is null`;
    if (!nb) return undefined;
    const [scope, threads, notes, flows, folders, grants] = await Promise.all([
      this.sql<{ patch: ScopePatch }[]>`
        select patch from core.scopes where level = 'notebook' and ref_id = ${notebookId}`,
      this.sql<{ id: string; title: string; cwd: string | null }[]>`
        select t.id, t.title,
          (select s.cwd from core.claude_code_sessions s where s.thread_id = t.id limit 1) as cwd
        from core.threads t where t.notebook_id = ${notebookId} and t.deleted_at is null
        order by t.updated_at desc`,
      this.sql<{ id: string; title: string }[]>`
        select id, title from core.notes where notebook_id = ${notebookId} and deleted_at is null
        order by updated_at desc`,
      this.sql<{ id: string; name: string; active: boolean }[]>`
        select id, name, active from core.flows
        where scope = 'notebook' and scope_ref = ${notebookId} and deleted_at is null order by name`,
      this.sql<{ cwd_key: string; cwd: string }[]>`
        select cwd_key, cwd from core.claude_code_projects where notebook_id = ${notebookId} order by cwd`,
      this.sql<{ n: number }[]>`
        select count(*)::int as n from core.grants
        where scope = 'notebook' and scope_ref = ${notebookId} and revoked_at is null`,
    ]);
    return {
      id: nb.id,
      workspace_id: nb.workspace_id,
      title: nb.title,
      slug: nb.slug,
      private: nb.private,
      patch: (scope[0]?.patch ?? {}) as ScopePatch,
      has_scope_row: !!scope[0],
      instructions: instructionsOf(nb.settings),
      threads: [...threads],
      notes: [...notes],
      flows: [...flows],
      folders: [...folders],
      grants: grants[0]?.n ?? 0,
    };
  }

  private async links(tx: Sql | TransactionSql, nb: string): Promise<LinkRecord[]> {
    const rows = await tx<LinkRowPg[]>`
      select * from core.context_links
      where (from_kind = 'notebook' and from_id = ${nb}) or (to_kind = 'notebook' and to_id = ${nb})
      order by created_at, id`;
    return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
  }

  async linkCounts(intoId: string, fromId: string) {
    const all = await this.links(this.sql, fromId);
    let retarget_ = 0;
    let dropped = 0;
    const seen = new Set(
      (
        await this.sql<{ k: string }[]>`
        select from_kind || ':' || from_id || '>' || to_kind || ':' || to_id as k from core.context_links`
      ).map((r) => r.k),
    );
    for (const l of all) {
      const n = retarget(l, intoId, fromId);
      const key = `${n.from_kind}:${n.from_id}>${n.to_kind}:${n.to_id}`;
      if ((n.from_kind === n.to_kind && n.from_id === n.to_id) || seen.has(key)) dropped++;
      else {
        retarget_++;
        seen.add(key);
      }
    }
    return { retarget: retarget_, dropped };
  }

  async apply(plan: ApplyPlan): Promise<MergeRow> {
    const { into, from } = plan;
    return (await this.sql.begin(async (tx) => {
      const locked = await tx<{ id: string }[]>`
        select id from core.notebooks where id = any(${[into.id, from.id]}) and deleted_at is null
        and workspace_id = ${plan.workspace_id} for update`;
      if (locked.length !== 2) throw new MergeConflict('a notebook was deleted or merged meanwhile');
      const threads = await tx<{ id: string }[]>`
        update core.threads set notebook_id = ${into.id}, updated_at = now()
        where notebook_id = ${from.id} returning id`;
      const notes = await tx<{ id: string }[]>`
        update core.notes set notebook_id = ${into.id} where notebook_id = ${from.id} and deleted_at is null
        returning id`;
      const intoActive = await tx<{ id: string }[]>`
        select id from core.flows where scope = 'notebook' and scope_ref = ${into.id} and active and deleted_at is null`;
      const flows = await tx<{ id: string; active: boolean }[]>`
        select id, active from core.flows where scope = 'notebook' and scope_ref = ${from.id} and deleted_at is null
        for update`;
      // One active flow per notebook: B's arrives switched off when A already has one.
      if (intoActive.length)
        await tx`update core.flows set active = false where id = any(${flows.map((f) => f.id)})`;
      await tx`update core.flows set scope_ref = ${into.id}, updated_at = now() where id = any(${flows.map((f) => f.id)})`;
      const folders = await tx<{ cwd_key: string }[]>`
        update core.claude_code_projects set notebook_id = ${into.id}, updated_at = now()
        where notebook_id = ${from.id} and workspace_id = ${plan.workspace_id} returning cwd_key`;
      const linkLog: MergeRecordData['links'] = [];
      for (const l of await this.links(tx, from.id)) {
        const n = retarget(l, into.id, from.id);
        const [clash] = await tx<{ id: string }[]>`
          select id from core.context_links where from_kind = ${n.from_kind} and from_id = ${n.from_id}
          and to_kind = ${n.to_kind} and to_id = ${n.to_id} and id <> ${l.id}`;
        if ((n.from_kind === n.to_kind && n.from_id === n.to_id) || clash) {
          await tx`delete from core.context_links where id = ${l.id}`;
          linkLog.push({ before: l, action: 'dropped' });
        } else {
          await tx`update core.context_links set from_id = ${n.from_id}, to_id = ${n.to_id} where id = ${l.id}`;
          linkLog.push({ before: l, action: 'retargeted' });
        }
      }
      const shared = await tx<{ id: string }[]>`
        insert into core.scope_shared_history (id, level, ref_id, change, turns, first_at, last_at, destinations, changed_at)
        select id || '@' || ${plan.id}, 'notebook', ${into.id}, change, turns, first_at, last_at, destinations, changed_at
        from core.scope_shared_history where level = 'notebook' and ref_id = ${from.id}
        on conflict (id) do nothing returning id`;
      await tx`
        insert into core.scopes (level, ref_id, patch) values ('notebook', ${into.id}, ${tx.json(pgSafe(plan.scope.patch) as never)})
        on conflict (level, ref_id) do update set patch = excluded.patch, updated_at = now()`;
      await tx`
        update core.notebooks set private = ${plan.scope.private},
          settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{ancile}', ${tx.json(pgSafe(plan.instructions) as never)}),
          updated_at = now()
        where id = ${into.id}`;
      for (const t of plan.tombstones)
        await tx`
          insert into core.source_tombstones (source_id, workspace_id, title, kind, reason, merged_into)
          values (${t.source_id}, ${plan.workspace_id}, ${t.title}, ${t.kind}, 'merged', ${t.merged_into})
          on conflict (source_id) do update set title = excluded.title, kind = excluded.kind,
            reason = excluded.reason, merged_into = excluded.merged_into, deleted_at = now()`;
      await tx`
        update core.notebooks set deleted_at = now(), merged_into = ${into.id}, updated_at = now() where id = ${from.id}`;
      const record: MergeRecordData = {
        threads: threads.map((t) => t.id),
        notes: notes.map((n) => n.id),
        flows: flows.map((f) => ({ id: f.id, was_active: f.active })),
        folders: folders.map((f) => f.cwd_key),
        links: linkLog,
        shared_history: shared.map((s) => s.id),
        into_before: {
          patch: into.patch,
          has_scope_row: into.has_scope_row,
          private: into.private,
          instructions: into.instructions,
        },
        kn: plan.kn,
        memory_commit: plan.memory_commit,
        tombstones: plan.tombstones.map((t) => t.source_id),
        scope_narrowed: plan.scope_narrowed,
      };
      const [row] = await tx<RowShape[]>`
        insert into core.notebook_merges (id, workspace_id, into_id, from_id, from_title, record, undo_until)
        values (${plan.id}, ${plan.workspace_id}, ${into.id}, ${from.id}, ${from.title},
          ${tx.json(pgSafe(record) as never)}, ${plan.undo_until})
        returning *`;
      return fromRow(row as RowShape);
    })) as MergeRow;
  }

  async undo(id: string): Promise<MergeRow> {
    return (await this.sql.begin(async (tx) => {
      const [m] = await tx<RowShape[]>`select * from core.notebook_merges where id = ${id} for update`;
      if (!m || m.undone_at) throw new MergeConflict('nothing to undo');
      const row = fromRow(m);
      const r = row.record;
      const [into] = await tx<{ id: string }[]>`
        select id from core.notebooks where id = ${row.into_id} and deleted_at is null for update`;
      if (!into) throw new MergeConflict('the notebook merged into is gone');
      await tx`update core.notebooks set deleted_at = null, merged_into = null, updated_at = now() where id = ${row.from_id}`;
      await tx`update core.threads set notebook_id = ${row.from_id}, updated_at = now()
        where id = any(${r.threads}) and notebook_id = ${row.into_id}`;
      await tx`update core.notes set notebook_id = ${row.from_id}
        where id = any(${r.notes}) and notebook_id = ${row.into_id}`;
      for (const f of r.flows)
        await tx`update core.flows set scope_ref = ${row.from_id}, active = ${f.was_active}, updated_at = now()
          where id = ${f.id} and scope = 'notebook' and scope_ref = ${row.into_id}`;
      await tx`update core.claude_code_projects set notebook_id = ${row.from_id}, updated_at = now()
        where cwd_key = any(${r.folders}) and notebook_id = ${row.into_id} and workspace_id = ${row.workspace_id}`;
      for (const { before: l, action } of r.links) {
        if (action === 'dropped')
          await tx`
            insert into core.context_links (id, workspace_id, from_kind, from_id, to_kind, to_id, kind, created_at)
            values (${l.id}, ${l.workspace_id}, ${l.from_kind}, ${l.from_id}, ${l.to_kind}, ${l.to_id}, ${l.kind}, ${l.created_at})
            on conflict do nothing`;
        else
          await tx`update core.context_links set from_id = ${l.from_id}, to_id = ${l.to_id} where id = ${l.id}`;
      }
      await tx`delete from core.scope_shared_history where id = any(${r.shared_history})`;
      if (r.into_before.has_scope_row)
        await tx`update core.scopes set patch = ${tx.json(pgSafe(r.into_before.patch) as never)}, updated_at = now()
          where level = 'notebook' and ref_id = ${row.into_id}`;
      else await tx`delete from core.scopes where level = 'notebook' and ref_id = ${row.into_id}`;
      await tx`
        update core.notebooks set private = ${r.into_before.private},
          settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{ancile}', ${tx.json(pgSafe(r.into_before.instructions) as never)}),
          updated_at = now()
        where id = ${row.into_id}`;
      await tx`delete from core.source_tombstones where source_id = any(${r.tombstones}) and reason = 'merged'`;
      const [done] = await tx<RowShape[]>`
        update core.notebook_merges set undone_at = now() where id = ${id} returning *`;
      return fromRow(done as RowShape);
    })) as MergeRow;
  }

  async get(id: string) {
    const [r] = await this.sql<RowShape[]>`select * from core.notebook_merges where id = ${id}`;
    return r ? fromRow(r) : undefined;
  }

  async list(notebookId: string) {
    const rows = await this.sql<RowShape[]>`
      select * from core.notebook_merges where into_id = ${notebookId} or from_id = ${notebookId}
      order by merged_at desc, id desc limit 100`;
    return rows.map(fromRow);
  }
}

/* ---- Memory (unit tests, harness) ---------------------------------------- */

export interface MemoryNotebookRow {
  id: string;
  workspace_id: string;
  title: string;
  slug: string;
  instructions?: AncileInstructions;
  deleted?: boolean;
  merged_into?: string | null;
}

/**
 * The rows a merge touches, in memory. Scopes, links and tombstones are the
 * same in-memory stores the rest of a test uses, so a merge is visible to them.
 */
export class MemoryMergeStore implements MergeStore {
  readonly notebooks = new Map<string, MemoryNotebookRow>();
  readonly threads = new Map<string, { title: string; notebook_id: string | null; cwd?: string | null }>();
  readonly notes = new Map<string, { title: string; notebook_id: string }>();
  readonly flows = new Map<string, { name: string; notebook_id: string; active: boolean }>();
  readonly folders = new Map<string, { cwd: string; notebook_id: string }>();
  readonly grants = new Map<string, number>();
  readonly sharedHistory = new Map<string, { notebook_id: string }>();
  readonly merges = new Map<string, MergeRow>();

  constructor(
    private readonly deps: {
      scopes: MemoryScopeStore;
      links: MemoryLinkStore;
      tombstones: MemoryTombstoneStore;
      now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async side(notebookId: string): Promise<MergeSideInfo | undefined> {
    const nb = this.notebooks.get(notebookId);
    if (!nb || nb.deleted) return undefined;
    const stored = await this.deps.scopes.getPatch('notebook', notebookId);
    return {
      id: nb.id,
      workspace_id: nb.workspace_id,
      title: nb.title,
      slug: nb.slug,
      private: await this.deps.scopes.isPrivate(notebookId),
      patch: stored.patch,
      has_scope_row: stored.updated_at !== null,
      instructions: nb.instructions ?? { ...EMPTY_INSTRUCTIONS },
      threads: [...this.threads]
        .filter(([, t]) => t.notebook_id === notebookId)
        .map(([id, t]) => ({ id, title: t.title, cwd: t.cwd ?? null })),
      notes: [...this.notes]
        .filter(([, n]) => n.notebook_id === notebookId)
        .map(([id, n]) => ({ id, title: n.title })),
      flows: [...this.flows]
        .filter(([, f]) => f.notebook_id === notebookId)
        .map(([id, f]) => ({ id, name: f.name, active: f.active })),
      folders: [...this.folders]
        .filter(([, f]) => f.notebook_id === notebookId)
        .map(([cwd_key, f]) => ({ cwd_key, cwd: f.cwd })),
      grants: this.grants.get(notebookId) ?? 0,
    };
  }

  async linkCounts(intoId: string, fromId: string) {
    const all = [...this.deps.links.rows.values()];
    const seen = new Set(all.map((l) => `${l.from_kind}:${l.from_id}>${l.to_kind}:${l.to_id}`));
    let retarget_ = 0;
    let dropped = 0;
    for (const l of all.filter((x) => touches(x, fromId))) {
      const n = retarget(l, intoId, fromId);
      const key = `${n.from_kind}:${n.from_id}>${n.to_kind}:${n.to_id}`;
      if ((n.from_kind === n.to_kind && n.from_id === n.to_id) || seen.has(key)) dropped++;
      else {
        retarget_++;
        seen.add(key);
      }
    }
    return { retarget: retarget_, dropped };
  }

  async apply(plan: ApplyPlan): Promise<MergeRow> {
    const { into, from } = plan;
    const a = this.notebooks.get(into.id);
    const b = this.notebooks.get(from.id);
    if (!a || !b || a.deleted || b.deleted)
      throw new MergeConflict('a notebook was deleted or merged meanwhile');
    const threads: string[] = [];
    for (const [id, t] of this.threads)
      if (t.notebook_id === from.id) {
        t.notebook_id = into.id;
        threads.push(id);
      }
    const notes: string[] = [];
    for (const [id, n] of this.notes)
      if (n.notebook_id === from.id) {
        n.notebook_id = into.id;
        notes.push(id);
      }
    const intoActive = [...this.flows.values()].some((f) => f.notebook_id === into.id && f.active);
    const flows: MergeRecordData['flows'] = [];
    for (const [id, f] of this.flows)
      if (f.notebook_id === from.id) {
        flows.push({ id, was_active: f.active });
        f.notebook_id = into.id;
        if (intoActive) f.active = false;
      }
    const folders: string[] = [];
    for (const [key, f] of this.folders)
      if (f.notebook_id === from.id) {
        f.notebook_id = into.id;
        folders.push(key);
      }
    const linkLog: MergeRecordData['links'] = [];
    for (const l of [...this.deps.links.rows.values()].filter((x) => touches(x, from.id))) {
      const n = retarget(l, into.id, from.id);
      const clash = [...this.deps.links.rows.values()].some(
        (o) =>
          o.id !== l.id &&
          o.from_kind === n.from_kind &&
          o.from_id === n.from_id &&
          o.to_kind === n.to_kind &&
          o.to_id === n.to_id,
      );
      if ((n.from_kind === n.to_kind && n.from_id === n.to_id) || clash) {
        this.deps.links.rows.delete(l.id);
        linkLog.push({ before: { ...l }, action: 'dropped' });
      } else {
        this.deps.links.rows.set(l.id, n);
        linkLog.push({ before: { ...l }, action: 'retargeted' });
      }
    }
    const shared: string[] = [];
    for (const [id, h] of [...this.sharedHistory])
      if (h.notebook_id === from.id) {
        const copy = `${id}@${plan.id}`;
        this.sharedHistory.set(copy, { notebook_id: into.id });
        shared.push(copy);
      }
    await this.deps.scopes.mergePatch('notebook', into.id, {
      ...Object.fromEntries(Object.keys(into.patch).map((k) => [k, null])),
      ...plan.scope.patch,
    });
    await this.deps.scopes.setPrivate(into.id, plan.scope.private);
    a.instructions = { ...plan.instructions };
    for (const t of plan.tombstones)
      await this.deps.tombstones.record({
        source_id: t.source_id,
        workspace_id: plan.workspace_id,
        title: t.title,
        kind: t.kind,
        reason: 'merged',
        merged_into: t.merged_into,
      });
    b.deleted = true;
    b.merged_into = into.id;
    for (const [id, t] of this.deps.scopes.threads)
      if (t === from.id) this.deps.scopes.threads.set(id, into.id);
    const row: MergeRow = {
      id: plan.id,
      workspace_id: plan.workspace_id,
      into_id: into.id,
      from_id: from.id,
      from_title: from.title,
      record: {
        threads,
        notes,
        flows,
        folders,
        links: linkLog,
        shared_history: shared,
        into_before: {
          patch: into.patch,
          has_scope_row: into.has_scope_row,
          private: into.private,
          instructions: into.instructions,
        },
        kn: plan.kn,
        memory_commit: plan.memory_commit,
        tombstones: plan.tombstones.map((t) => t.source_id),
        scope_narrowed: plan.scope_narrowed,
      },
      merged_at: this.now().toISOString(),
      undo_until: plan.undo_until.toISOString(),
      undone_at: null,
    };
    this.merges.set(row.id, row);
    return structuredClone(row);
  }

  async undo(id: string): Promise<MergeRow> {
    const row = this.merges.get(id);
    if (!row || row.undone_at) throw new MergeConflict('nothing to undo');
    const a = this.notebooks.get(row.into_id);
    const b = this.notebooks.get(row.from_id);
    if (!a || a.deleted || !b) throw new MergeConflict('the notebook merged into is gone');
    const r = row.record;
    b.deleted = false;
    b.merged_into = null;
    for (const tid of r.threads) {
      const t = this.threads.get(tid);
      if (t?.notebook_id === row.into_id) t.notebook_id = row.from_id;
      if (this.deps.scopes.threads.get(tid) === row.into_id) this.deps.scopes.threads.set(tid, row.from_id);
    }
    for (const nid of r.notes) {
      const n = this.notes.get(nid);
      if (n?.notebook_id === row.into_id) n.notebook_id = row.from_id;
    }
    for (const f of r.flows) {
      const flow = this.flows.get(f.id);
      if (flow?.notebook_id === row.into_id) {
        flow.notebook_id = row.from_id;
        flow.active = f.was_active;
      }
    }
    for (const key of r.folders) {
      const f = this.folders.get(key);
      if (f?.notebook_id === row.into_id) f.notebook_id = row.from_id;
    }
    for (const { before, action } of r.links) {
      if (action === 'dropped' && !this.deps.links.rows.has(before.id))
        this.deps.links.rows.set(before.id, before);
      else if (action === 'retargeted') this.deps.links.rows.set(before.id, before);
    }
    for (const h of r.shared_history) this.sharedHistory.delete(h);
    const current = await this.deps.scopes.getPatch('notebook', row.into_id);
    await this.deps.scopes.mergePatch('notebook', row.into_id, {
      ...Object.fromEntries(Object.keys(current.patch).map((k) => [k, null])),
      ...r.into_before.patch,
    });
    await this.deps.scopes.setPrivate(row.into_id, r.into_before.private);
    a.instructions = { ...r.into_before.instructions };
    for (const s of r.tombstones) {
      const t = this.deps.tombstones.rows.get(s);
      if (t?.reason === 'merged') this.deps.tombstones.rows.delete(s);
    }
    row.undone_at = this.now().toISOString();
    return structuredClone(row);
  }

  async get(id: string) {
    const r = this.merges.get(id);
    return r ? structuredClone(r) : undefined;
  }

  async list(notebookId: string) {
    return [...this.merges.values()]
      .filter((m) => m.into_id === notebookId || m.from_id === notebookId)
      .sort((x, y) => y.merged_at.localeCompare(x.merged_at) || y.id.localeCompare(x.id))
      .map((m) => structuredClone(m));
  }
}
