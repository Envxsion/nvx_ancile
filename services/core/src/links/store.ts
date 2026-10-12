/**
 * ------------------------------------------------------------------
 *  Title    |  Context links at rest
 *  Ref      |  docs/notebooks.md (Context links) · migrations/0031
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keep which thread or notebook may draw on which other
 *           |  notebook's sources or thread's summary.
 *  How      |  core.context_links in Postgres, one row per link, unique
 *           |  per pair; MemoryLinkStore for tests and the harness.
 *  Note     |  A row says nothing about whether a read is allowed: that
 *           |  is decided from both scopes at the moment of reading.
 * ------------------------------------------------------------------
 */

import type { Sql } from 'postgres';

export type LinkEndKind = 'thread' | 'notebook';

export interface LinkRecord {
  id: string;
  workspace_id: string;
  from_kind: LinkEndKind;
  from_id: string;
  to_kind: LinkEndKind;
  to_id: string;
  kind: 'sources' | 'summary';
  created_at: string;
}

export interface LinkEnd {
  kind: LinkEndKind;
  id: string;
}

export interface LinkStore {
  /** Undefined when the same pair is already linked. */
  create(l: Omit<LinkRecord, 'created_at'>): Promise<LinkRecord | undefined>;
  get(id: string): Promise<LinkRecord | undefined>;
  remove(id: string): Promise<boolean>;
  /** Links whose reading side is one of these ends, oldest first. */
  outgoing(ends: LinkEnd[]): Promise<LinkRecord[]>;
  /** Links that read from this end, oldest first. */
  incoming(end: LinkEnd): Promise<LinkRecord[]>;
}

const sortOld = (a: LinkRecord, b: LinkRecord) =>
  a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

export class MemoryLinkStore implements LinkStore {
  readonly rows = new Map<string, LinkRecord>();
  private tick = 0;

  async create(l: Omit<LinkRecord, 'created_at'>) {
    for (const r of this.rows.values())
      if (
        r.from_kind === l.from_kind &&
        r.from_id === l.from_id &&
        r.to_kind === l.to_kind &&
        r.to_id === l.to_id
      )
        return undefined;
    const rec = { ...l, created_at: new Date(Date.UTC(2026, 9, 12, 9, 0, 0, this.tick++)).toISOString() };
    this.rows.set(l.id, rec);
    return { ...rec };
  }

  async get(id: string) {
    const r = this.rows.get(id);
    return r ? { ...r } : undefined;
  }

  async remove(id: string) {
    return this.rows.delete(id);
  }

  async outgoing(ends: LinkEnd[]) {
    return [...this.rows.values()]
      .filter((r) => ends.some((e) => e.kind === r.from_kind && e.id === r.from_id))
      .sort(sortOld)
      .map((r) => ({ ...r }));
  }

  async incoming(end: LinkEnd) {
    return [...this.rows.values()]
      .filter((r) => r.to_kind === end.kind && r.to_id === end.id)
      .sort(sortOld)
      .map((r) => ({ ...r }));
  }
}

interface LinkRow extends Omit<LinkRecord, 'created_at'> {
  created_at: Date;
}

const fromRow = (r: LinkRow): LinkRecord => ({ ...r, created_at: r.created_at.toISOString() });

export class PgLinkStore implements LinkStore {
  constructor(private readonly sql: Sql) {}

  async create(l: Omit<LinkRecord, 'created_at'>) {
    const rows = await this.sql<LinkRow[]>`
      insert into core.context_links (id, workspace_id, from_kind, from_id, to_kind, to_id, kind)
      values (${l.id}, ${l.workspace_id}, ${l.from_kind}, ${l.from_id}, ${l.to_kind}, ${l.to_id}, ${l.kind})
      on conflict (from_kind, from_id, to_kind, to_id) do nothing
      returning *`;
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async get(id: string) {
    const [r] = await this.sql<LinkRow[]>`select * from core.context_links where id = ${id}`;
    return r ? fromRow(r) : undefined;
  }

  async remove(id: string) {
    const rows = await this.sql`delete from core.context_links where id = ${id} returning id`;
    return rows.length > 0;
  }

  async outgoing(ends: LinkEnd[]) {
    if (!ends.length) return [];
    const keys = ends.map((e) => `${e.kind}:${e.id}`);
    const rows = await this.sql<LinkRow[]>`
      select * from core.context_links where (from_kind || ':' || from_id) = any(${keys})
      order by created_at, id`;
    return rows.map(fromRow);
  }

  async incoming(end: LinkEnd) {
    const rows = await this.sql<LinkRow[]>`
      select * from core.context_links where to_kind = ${end.kind} and to_id = ${end.id}
      order by created_at, id`;
    return rows.map(fromRow);
  }
}
