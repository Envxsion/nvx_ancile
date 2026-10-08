/**
 * ------------------------------------------------------------------
 *  Title    |  Branch names and summaries
 *  Ref      |  DESIGN.md §8.1, §8.4, §3.1 (branches, summaries)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The two small tables beside the message tree: named
 *           |  heads (a label and a colour on a path that exists
 *           |  anyway) and summaries (a compaction of a path's prefix,
 *           |  keyed by the message it covers up to, so every branch
 *           |  through that message reuses it).
 *  How      |  BranchStore is the interface; PgBranchStore is the real
 *           |  one, MemoryBranchStore backs unit tests. When a turn is
 *           |  answered on a named head, advance() moves the name to
 *           |  the new reply, so a branch keeps following its tip.
 * ------------------------------------------------------------------
 */

import type { Branch, BranchColor } from '@nvx/contracts';
import type { Sql } from 'postgres';

export interface SummaryRecord {
  id: string;
  thread_id: string;
  upto_message_id: string;
  kind: 'tldr' | 'compaction';
  content: string;
  tokens: number;
  model_id: string;
  created_at: string;
}

export interface BranchStore {
  list(threadId: string, opts?: { archived?: boolean }): Promise<Branch[]>;
  get(id: string): Promise<Branch | undefined>;
  create(b: Omit<Branch, 'archived_at' | 'created_at'>): Promise<Branch>;
  patch(
    id: string,
    p: { name?: string; color?: BranchColor; archived?: boolean },
  ): Promise<Branch | undefined>;
  /** Move every live name whose head is one of `from` to `to`. */
  advance(threadId: string, from: string[], to: string): Promise<void>;
  summaries(threadId: string, kind?: SummaryRecord['kind']): Promise<SummaryRecord[]>;
  addSummary(s: Omit<SummaryRecord, 'created_at'>): Promise<SummaryRecord>;
}

/* ---- Postgres ------------------------------------------------------------- */

interface BranchRow {
  id: string;
  thread_id: string;
  name: string;
  color: BranchColor;
  head_message_id: string;
  fork_message_id: string;
  created_by: 'user' | 'suggestion';
  archived_at: Date | null;
  created_at: Date;
}

interface SummaryRow extends Omit<SummaryRecord, 'created_at'> {
  created_at: Date;
}

const branchFromRow = (r: BranchRow): Branch => ({
  id: r.id,
  thread_id: r.thread_id,
  name: r.name,
  color: r.color,
  head_message_id: r.head_message_id,
  fork_message_id: r.fork_message_id,
  created_by: r.created_by,
  archived_at: r.archived_at ? r.archived_at.toISOString() : null,
  created_at: r.created_at.toISOString(),
});

const summaryFromRow = (r: SummaryRow): SummaryRecord => ({ ...r, created_at: r.created_at.toISOString() });

export class PgBranchStore implements BranchStore {
  constructor(private readonly sql: Sql) {}

  async list(threadId: string, opts: { archived?: boolean } = {}) {
    const sql = this.sql;
    const rows = await sql<BranchRow[]>`
      select b.* from core.branches b
      join core.messages m on m.id = b.head_message_id and m.deleted_at is null
      where b.thread_id = ${threadId}
        and ${opts.archived ? sql`true` : sql`b.archived_at is null`}
      order by b.created_at, b.id`;
    return rows.map(branchFromRow);
  }

  async get(id: string) {
    const rows = await this.sql<BranchRow[]>`select * from core.branches where id = ${id}`;
    return rows[0] ? branchFromRow(rows[0]) : undefined;
  }

  async create(b: Omit<Branch, 'archived_at' | 'created_at'>) {
    const rows = await this.sql<BranchRow[]>`
      insert into core.branches (id, thread_id, name, color, head_message_id, fork_message_id, created_by)
      values (${b.id}, ${b.thread_id}, ${b.name}, ${b.color}, ${b.head_message_id}, ${b.fork_message_id}, ${b.created_by})
      returning *`;
    return branchFromRow(rows[0] as BranchRow);
  }

  async patch(id: string, p: { name?: string; color?: BranchColor; archived?: boolean }) {
    const rows = await this.sql<BranchRow[]>`
      update core.branches set
        name = coalesce(${p.name ?? null}, name),
        color = coalesce(${p.color ?? null}, color),
        archived_at = case when ${p.archived === undefined} then archived_at
          when ${p.archived === true} then coalesce(archived_at, now()) else null end
      where id = ${id}
      returning *`;
    return rows[0] ? branchFromRow(rows[0]) : undefined;
  }

  async advance(threadId: string, from: string[], to: string) {
    if (!from.length) return;
    await this.sql`
      update core.branches set head_message_id = ${to}
      where thread_id = ${threadId} and archived_at is null and head_message_id in ${this.sql(from)}`;
  }

  async summaries(threadId: string, kind?: SummaryRecord['kind']) {
    const sql = this.sql;
    const rows = await sql<SummaryRow[]>`
      select * from core.summaries where thread_id = ${threadId}
        ${kind ? sql`and kind = ${kind}` : sql``}
      order by created_at, id`;
    return rows.map(summaryFromRow);
  }

  async addSummary(s: Omit<SummaryRecord, 'created_at'>) {
    const rows = await this.sql<SummaryRow[]>`
      insert into core.summaries (id, thread_id, upto_message_id, kind, content, tokens, model_id)
      values (${s.id}, ${s.thread_id}, ${s.upto_message_id}, ${s.kind}, ${s.content}, ${s.tokens}, ${s.model_id})
      returning *`;
    return summaryFromRow(rows[0] as SummaryRow);
  }
}

/* ---- Memory (unit tests) -------------------------------------------------- */

export class MemoryBranchStore implements BranchStore {
  readonly rows = new Map<string, Branch>();
  readonly sums: SummaryRecord[] = [];
  private tick = 0;
  /** Heads that are deleted, for list(); tests and the memory repo set this. */
  isLive: (messageId: string) => boolean = () => true;

  private stamp() {
    return new Date(Date.UTC(2026, 9, 7, 13, 0, 0, this.tick++)).toISOString();
  }

  async list(threadId: string, opts: { archived?: boolean } = {}) {
    return [...this.rows.values()]
      .filter(
        (b) =>
          b.thread_id === threadId && (opts.archived || !b.archived_at) && this.isLive(b.head_message_id),
      )
      .map((b) => ({ ...b }));
  }

  async get(id: string) {
    const b = this.rows.get(id);
    return b ? { ...b } : undefined;
  }

  async create(b: Omit<Branch, 'archived_at' | 'created_at'>) {
    const rec: Branch = { ...b, archived_at: null, created_at: this.stamp() };
    this.rows.set(b.id, rec);
    return { ...rec };
  }

  async patch(id: string, p: { name?: string; color?: BranchColor; archived?: boolean }) {
    const b = this.rows.get(id);
    if (!b) return undefined;
    if (p.name !== undefined) b.name = p.name;
    if (p.color !== undefined) b.color = p.color;
    if (p.archived !== undefined) b.archived_at = p.archived ? (b.archived_at ?? this.stamp()) : null;
    return { ...b };
  }

  async advance(threadId: string, from: string[], to: string) {
    for (const b of this.rows.values())
      if (b.thread_id === threadId && !b.archived_at && from.includes(b.head_message_id))
        b.head_message_id = to;
  }

  async summaries(threadId: string, kind?: SummaryRecord['kind']) {
    return this.sums
      .filter((s) => s.thread_id === threadId && (!kind || s.kind === kind))
      .map((s) => ({ ...s }));
  }

  async addSummary(s: Omit<SummaryRecord, 'created_at'>) {
    const rec = { ...s, created_at: this.stamp() };
    this.sums.push(rec);
    return { ...rec };
  }
}
