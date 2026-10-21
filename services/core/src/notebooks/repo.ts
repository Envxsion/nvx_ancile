/**
 * ------------------------------------------------------------------
 *  Title    |  Notebooks and notes
 *  Ref      |  DESIGN.md §3.1 · ROADMAP.md Phase 3
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Core owns the notebook itself (name, colour, pin) and
 *           |  the notes kept in it; Knowledge owns its sources and
 *           |  links them by notebook id.
 *  How      |  NotebookRepo is the interface the routes use;
 *           |  PgNotebookRepo is real, MemoryNotebookRepo backs tests.
 *           |  Deletes are soft (deleted_at), so a mistake can be
 *           |  undone from the database by hand.
 * ------------------------------------------------------------------
 */

import type { Note } from '@nvx/contracts';
import type { Sql } from 'postgres';
import type { LinkStore } from '../links/store';
import { inheritInStore, inheritIntoThreads } from '../scopes/inherit';
import type { ScopeStore } from '../scopes/store';
import type { MemoryThreadRepo } from '../threads/repo';

export interface NotebookRecord {
  id: string;
  workspace_id: string;
  title: string;
  slug: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  pinned_at: string | null;
  archived_at: string | null;
  last_opened_at: string | null;
  created_at: string;
  updated_at: string;
  /** Grounded mode: every answer is fact-checked when it finishes (DESIGN.md §10.7). */
  grounded: boolean;
  /** Fact-checks here may look claims up on the web (FC4). */
  check_on_web: boolean;
  /** Mission-critical fact-checks (TR3). */
  critical: boolean;
  /** Verdicts shared with other notebooks (SI1). */
  share_checks: boolean;
}

export interface NotebookPatch {
  title?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  pinned?: boolean;
  archived?: boolean;
  opened?: boolean;
  grounded?: boolean;
  check_on_web?: boolean;
  critical?: boolean;
  share_checks?: boolean;
}

export interface NoteRecord extends Note {
  deleted_at?: string | null;
}

export interface NotebookRepo {
  list(workspaceId: string): Promise<NotebookRecord[]>;
  get(id: string): Promise<NotebookRecord | undefined>;
  create(n: {
    id: string;
    workspace_id: string;
    title: string;
    description?: string | null;
    icon?: string | null;
    color?: string | null;
  }): Promise<NotebookRecord>;
  patch(id: string, p: NotebookPatch): Promise<NotebookRecord | undefined>;
  remove(id: string): Promise<boolean>;
  notes(notebookId: string): Promise<NoteRecord[]>;
  noteCounts(workspaceId: string): Promise<Map<string, number>>;
  getNote(id: string): Promise<NoteRecord | undefined>;
  createNote(n: {
    id: string;
    notebook_id: string;
    kind: 'human' | 'ai';
    title: string;
    content_md: string;
    from_message_id?: string | null;
  }): Promise<NoteRecord>;
  patchNote(
    id: string,
    p: { title?: string; content_md?: string; pinned?: boolean },
  ): Promise<NoteRecord | undefined>;
  removeNote(id: string): Promise<boolean>;
}

/** A url-safe slug, unique within the workspace by suffix. */
export function slugify(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'notebook'
  );
}

/* ---- Postgres ------------------------------------------------------------- */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

interface NotebookRow {
  id: string;
  workspace_id: string;
  title: string;
  slug: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  pinned_at: Date | null;
  archived_at: Date | null;
  last_opened_at: Date | null;
  created_at: Date;
  updated_at: Date;
  settings: Record<string, unknown> | null;
}

export const nbFromRow = (r: NotebookRow, webDefault = true): NotebookRecord => ({
  id: r.id,
  workspace_id: r.workspace_id,
  title: r.title,
  slug: r.slug,
  description: r.description,
  icon: r.icon,
  color: r.color,
  pinned_at: iso(r.pinned_at),
  archived_at: iso(r.archived_at),
  last_opened_at: iso(r.last_opened_at),
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
  grounded: r.settings?.grounded === true,
  check_on_web: typeof r.settings?.check_on_web === 'boolean' ? r.settings.check_on_web : webDefault,
  critical: r.settings?.critical === true,
  share_checks: r.settings?.share_checks === true,
});

interface NoteRow {
  id: string;
  notebook_id: string;
  kind: 'human' | 'ai';
  title: string;
  content_md: string;
  from_message_id: string | null;
  pinned_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const noteFromRow = (r: NoteRow): NoteRecord => ({
  id: r.id,
  notebook_id: r.notebook_id,
  kind: r.kind,
  title: r.title,
  content_md: r.content_md,
  from_message_id: r.from_message_id,
  pinned: r.pinned_at !== null,
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
});

export class PgNotebookRepo implements NotebookRepo {
  constructor(
    private readonly sql: Sql,
    /** What a notebook that never chose gets for "use the web" (config/factcheck.yaml web_search). */
    private readonly opts: { webDefault?: () => boolean } = {},
  ) {}

  private from = (r: NotebookRow): NotebookRecord => nbFromRow(r, this.opts.webDefault?.() ?? true);

  async list(workspaceId: string) {
    const rows = await this.sql<NotebookRow[]>`
      select * from core.notebooks where workspace_id = ${workspaceId} and deleted_at is null
      order by pinned_at desc nulls last, coalesce(last_opened_at, updated_at) desc`;
    return rows.map(this.from);
  }

  async get(id: string) {
    const rows = await this.sql<
      NotebookRow[]
    >`select * from core.notebooks where id = ${id} and deleted_at is null`;
    return rows[0] ? this.from(rows[0]) : undefined;
  }

  async create(n: Parameters<NotebookRepo['create']>[0]) {
    const base = slugify(n.title);
    const taken = await this.sql<{ slug: string }[]>`
      select slug from core.notebooks where workspace_id = ${n.workspace_id} and (slug = ${base} or slug like ${`${base}-%`})`;
    const used = new Set(taken.map((t) => t.slug));
    let slug = base;
    for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
    const rows = await this.sql<NotebookRow[]>`
      insert into core.notebooks (id, workspace_id, title, slug, description, icon, color, memory_path)
      values (${n.id}, ${n.workspace_id}, ${n.title}, ${slug}, ${n.description ?? null}, ${n.icon ?? null},
        ${n.color ?? null}, ${`notebooks/${slug}`})
      returning *`;
    return this.from(rows[0] as NotebookRow);
  }

  async patch(id: string, p: NotebookPatch) {
    const rows = await this.sql<NotebookRow[]>`
      update core.notebooks set
        title = coalesce(${p.title ?? null}, title),
        description = case when ${p.description === undefined} then description else ${p.description ?? null} end,
        icon = case when ${p.icon === undefined} then icon else ${p.icon ?? null} end,
        color = case when ${p.color === undefined} then color else ${p.color ?? null} end,
        pinned_at = case when ${p.pinned === undefined} then pinned_at
          when ${p.pinned === true} then coalesce(pinned_at, now()) else null end,
        archived_at = case when ${p.archived === undefined} then archived_at
          when ${p.archived === true} then coalesce(archived_at, now()) else null end,
        last_opened_at = case when ${p.opened === true} then now() else last_opened_at end,
        settings = settings || ${this.sql.json({
          ...(p.grounded !== undefined && { grounded: p.grounded === true }),
          ...(p.check_on_web !== undefined && { check_on_web: p.check_on_web === true }),
          ...(p.critical !== undefined && { critical: p.critical === true }),
          ...(p.share_checks !== undefined && { share_checks: p.share_checks === true }),
        } as never)},
        updated_at = case when ${p.opened === true && Object.keys(p).length === 1} then updated_at else now() end
      where id = ${id} and deleted_at is null
      returning *`;
    return rows[0] ? this.from(rows[0]) : undefined;
  }

  /**
   * Delete the notebook and settle everything that pointed at it, in one transaction: its limits
   * (private, local only, any scope patch) move onto each of its threads first, then the threads
   * leave, its notes and links go, and its own scope rows, grants and image hosts are dropped.
   * Either all of that happens or none of it does.
   */
  async remove(id: string) {
    return this.sql.begin(async (tx) => {
      const live = await tx`select id from core.notebooks where id = ${id} and deleted_at is null for update`;
      if (!live.length) return false;
      // First, while the threads still know their notebook and its scope row still exists.
      await inheritIntoThreads(tx as unknown as Sql, id);
      // Threads stay (trashed and archived ones too); they just leave the notebook. placed_at is
      // the signal Sync reads, because a move must not reorder the rail by touching updated_at.
      await tx`update core.threads set notebook_id = null, placed_at = now() where notebook_id = ${id}`;
      await tx`update core.notes set deleted_at = now() where notebook_id = ${id} and deleted_at is null`;
      await tx`
        delete from core.context_links
        where (from_kind = 'notebook' and from_id = ${id}) or (to_kind = 'notebook' and to_id = ${id})`;
      await tx`delete from core.scopes where level = 'notebook' and ref_id = ${id}`;
      await tx`delete from core.image_remote_hosts where scope_key = ${id}`;
      await tx`
        update core.grants set revoked_at = now()
        where scope = 'notebook' and scope_ref = ${id} and revoked_at is null`;
      await tx`update core.notebooks set deleted_at = now() where id = ${id}`;
      return true;
    });
  }

  async notes(notebookId: string) {
    const rows = await this.sql<NoteRow[]>`
      select * from core.notes where notebook_id = ${notebookId} and deleted_at is null
      order by pinned_at desc nulls last, updated_at desc`;
    return rows.map(noteFromRow);
  }

  async noteCounts(workspaceId: string) {
    const rows = await this.sql<{ notebook_id: string; n: number }[]>`
      select n.notebook_id, count(*)::int as n from core.notes n
      join core.notebooks b on b.id = n.notebook_id
      where b.workspace_id = ${workspaceId} and n.deleted_at is null group by n.notebook_id`;
    return new Map(rows.map((r) => [r.notebook_id, r.n] as const));
  }

  async getNote(id: string) {
    const rows = await this.sql<NoteRow[]>`select * from core.notes where id = ${id} and deleted_at is null`;
    return rows[0] ? noteFromRow(rows[0]) : undefined;
  }

  async createNote(n: Parameters<NotebookRepo['createNote']>[0]) {
    const rows = await this.sql<NoteRow[]>`
      insert into core.notes (id, notebook_id, kind, title, content_md, from_message_id)
      values (${n.id}, ${n.notebook_id}, ${n.kind}, ${n.title}, ${n.content_md}, ${n.from_message_id ?? null})
      returning *`;
    return noteFromRow(rows[0] as NoteRow);
  }

  async patchNote(id: string, p: { title?: string; content_md?: string; pinned?: boolean }) {
    const rows = await this.sql<NoteRow[]>`
      update core.notes set
        title = coalesce(${p.title ?? null}, title),
        content_md = coalesce(${p.content_md ?? null}, content_md),
        pinned_at = case when ${p.pinned === undefined} then pinned_at
          when ${p.pinned === true} then coalesce(pinned_at, now()) else null end,
        updated_at = now()
      where id = ${id} and deleted_at is null
      returning *`;
    return rows[0] ? noteFromRow(rows[0]) : undefined;
  }

  async removeNote(id: string) {
    const rows = await this
      .sql`update core.notes set deleted_at = now() where id = ${id} and deleted_at is null returning id`;
    return rows.length > 0;
  }
}

/* ---- Memory (unit tests) -------------------------------------------------- */

export class MemoryNotebookRepo implements NotebookRepo {
  readonly books = new Map<string, NotebookRecord & { deleted_at?: string | null }>();
  readonly noteMap = new Map<string, NoteRecord>();
  private tick = 0;
  /** What a deleted notebook has to settle beyond its own record; absent in the tests that need none of it. */
  private partners: {
    threads?: MemoryThreadRepo;
    scopes?: ScopeStore;
    links?: Pick<LinkStore, 'removeForEnd'>;
  } = {};
  /** Anything else a test wants to happen when a notebook is deleted. */
  onRemove?: (notebookId: string) => Promise<void>;

  /** Tell this repo about the stores a real delete reaches (the Postgres repo does it in SQL). */
  wire(p: MemoryNotebookRepo['partners']): this {
    this.partners = p;
    return this;
  }

  private stamp() {
    return new Date(Date.UTC(2026, 9, 7, 12, 0, 0, this.tick++)).toISOString();
  }

  async list(workspaceId: string) {
    return [...this.books.values()]
      .filter((b) => b.workspace_id === workspaceId && !b.deleted_at)
      .sort(
        (a, b) =>
          Number(!!b.pinned_at) - Number(!!a.pinned_at) ||
          (b.last_opened_at ?? b.updated_at).localeCompare(a.last_opened_at ?? a.updated_at),
      )
      .map(({ deleted_at: _d, ...b }) => ({ ...b }));
  }

  async get(id: string) {
    const b = this.books.get(id);
    if (!b || b.deleted_at) return undefined;
    const { deleted_at: _d, ...rest } = b;
    return { ...rest };
  }

  async create(n: Parameters<NotebookRepo['create']>[0]) {
    const at = this.stamp();
    const base = slugify(n.title);
    const used = new Set(
      [...this.books.values()].filter((b) => b.workspace_id === n.workspace_id).map((b) => b.slug),
    );
    let slug = base;
    for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
    const rec: NotebookRecord = {
      id: n.id,
      workspace_id: n.workspace_id,
      title: n.title,
      slug,
      description: n.description ?? null,
      icon: n.icon ?? null,
      color: n.color ?? null,
      pinned_at: null,
      archived_at: null,
      last_opened_at: null,
      created_at: at,
      updated_at: at,
      grounded: false,
      check_on_web: true,
      critical: false,
      share_checks: false,
    };
    this.books.set(n.id, rec);
    return { ...rec };
  }

  async patch(id: string, p: NotebookPatch) {
    const b = this.books.get(id);
    if (!b || b.deleted_at) return undefined;
    if (p.title !== undefined) b.title = p.title;
    if (p.description !== undefined) b.description = p.description;
    if (p.icon !== undefined) b.icon = p.icon;
    if (p.color !== undefined) b.color = p.color;
    if (p.pinned !== undefined) b.pinned_at = p.pinned ? (b.pinned_at ?? this.stamp()) : null;
    if (p.archived !== undefined) b.archived_at = p.archived ? (b.archived_at ?? this.stamp()) : null;
    if (p.grounded !== undefined) b.grounded = p.grounded;
    if (p.check_on_web !== undefined) b.check_on_web = p.check_on_web;
    if (p.critical !== undefined) b.critical = p.critical;
    if (p.share_checks !== undefined) b.share_checks = p.share_checks;
    if (p.opened) b.last_opened_at = this.stamp();
    if (!(p.opened && Object.keys(p).length === 1)) b.updated_at = this.stamp();
    return this.get(id);
  }

  async remove(id: string) {
    const b = this.books.get(id);
    if (!b || b.deleted_at) return false;
    const { threads, scopes, links } = this.partners;
    if (threads) {
      // Every thread in it, whatever its state: live, archived or in the Trash.
      const ids = [...threads.threads.values()].filter((t) => t.notebook_id === id).map((t) => t.id);
      if (scopes) {
        await inheritInStore(scopes, id, ids);
        await scopes.forgetNotebook(id);
      }
      for (const tid of ids) await threads.setFields(b.workspace_id, tid, { notebook_id: null });
    }
    for (const n of this.noteMap.values())
      if (n.notebook_id === id && !n.deleted_at) n.deleted_at = this.stamp();
    await links?.removeForEnd({ kind: 'notebook', id });
    b.deleted_at = this.stamp();
    await this.onRemove?.(id);
    return true;
  }

  async notes(notebookId: string) {
    return [...this.noteMap.values()]
      .filter((n) => n.notebook_id === notebookId && !n.deleted_at)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at))
      .map(({ deleted_at: _d, ...n }) => ({ ...n }));
  }

  async noteCounts(workspaceId: string) {
    const out = new Map<string, number>();
    for (const n of this.noteMap.values()) {
      const b = this.books.get(n.notebook_id);
      if (n.deleted_at || !b || b.workspace_id !== workspaceId) continue;
      out.set(n.notebook_id, (out.get(n.notebook_id) ?? 0) + 1);
    }
    return out;
  }

  async getNote(id: string) {
    const n = this.noteMap.get(id);
    if (!n || n.deleted_at) return undefined;
    const { deleted_at: _d, ...rest } = n;
    return { ...rest };
  }

  async createNote(n: Parameters<NotebookRepo['createNote']>[0]) {
    const at = this.stamp();
    const rec: NoteRecord = {
      ...n,
      from_message_id: n.from_message_id ?? null,
      pinned: false,
      created_at: at,
      updated_at: at,
    };
    this.noteMap.set(n.id, rec);
    return { ...rec };
  }

  async patchNote(id: string, p: { title?: string; content_md?: string; pinned?: boolean }) {
    const n = this.noteMap.get(id);
    if (!n || n.deleted_at) return undefined;
    if (p.title !== undefined) n.title = p.title;
    if (p.content_md !== undefined) n.content_md = p.content_md;
    if (p.pinned !== undefined) n.pinned = p.pinned;
    n.updated_at = this.stamp();
    return this.getNote(id);
  }

  async removeNote(id: string) {
    const n = this.noteMap.get(id);
    if (!n || n.deleted_at) return false;
    n.deleted_at = this.stamp();
    return true;
  }
}
