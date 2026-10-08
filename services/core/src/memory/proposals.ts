/**
 * ------------------------------------------------------------------
 *  Title    |  Memory proposals
 *  Ref      |  DESIGN.md §3.1 (memory_proposals), §6.3
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Every change memory capture wants to make, applied or
 *           |  not: the inbox of what waits for you, and the record of
 *           |  what was applied on its own (with the commit to undo).
 *  How      |  core.memory_proposals in Postgres; an in-memory store for
 *           |  tests with the same behaviour.
 * ------------------------------------------------------------------
 */

import type { MemoryProposal } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { ulid } from 'ulid';

export type NewProposal = Omit<MemoryProposal, 'id' | 'created_at' | 'decided_at' | 'commit_sha'> & {
  commit_sha?: string | null;
};

export type ProposalPatch = Partial<Pick<MemoryProposal, 'status' | 'commit_sha' | 'text'>> & {
  decided?: boolean;
};

export interface ProposalStore {
  create(p: NewProposal): Promise<MemoryProposal>;
  get(id: string): Promise<MemoryProposal | undefined>;
  list(opts?: { status?: MemoryProposal['status'][]; limit?: number }): Promise<MemoryProposal[]>;
  pending(): Promise<number>;
  update(id: string, patch: ProposalPatch): Promise<MemoryProposal | undefined>;
}

export const newProposalId = () => `mpr_${ulid()}`;

export class MemoryProposalStore implements ProposalStore {
  private rows = new Map<string, MemoryProposal>();

  async create(p: NewProposal): Promise<MemoryProposal> {
    const row: MemoryProposal = {
      ...structuredClone(p),
      id: newProposalId(),
      commit_sha: p.commit_sha ?? null,
      created_at: new Date().toISOString(),
      decided_at: p.status === 'proposed' ? null : new Date().toISOString(),
    };
    this.rows.set(row.id, row);
    return structuredClone(row);
  }

  async get(id: string) {
    const r = this.rows.get(id);
    return r && structuredClone(r);
  }

  async list(opts: { status?: MemoryProposal['status'][]; limit?: number } = {}) {
    return [...this.rows.values()]
      .filter((r) => !opts.status || opts.status.includes(r.status))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .slice(0, opts.limit ?? 100)
      .map((r) => structuredClone(r));
  }

  async pending() {
    return [...this.rows.values()].filter((r) => r.status === 'proposed').length;
  }

  async update(id: string, patch: ProposalPatch) {
    const r = this.rows.get(id);
    if (!r) return undefined;
    const { decided, ...rest } = patch;
    Object.assign(r, rest, decided ? { decided_at: new Date().toISOString() } : {});
    return structuredClone(r);
  }
}

interface Row {
  id: string;
  kind: MemoryProposal['kind'];
  target_path: string;
  op: MemoryProposal['op'];
  section: string;
  text: string;
  target_key: string | null;
  target_text: string | null;
  rationale: string;
  confidence: number;
  provenance: MemoryProposal['provenance'];
  evidence: MemoryProposal['evidence'];
  status: MemoryProposal['status'];
  commit_sha: string | null;
  created_at: Date;
  decided_at: Date | null;
}

const fromRow = (r: Row): MemoryProposal => ({
  id: r.id,
  kind: r.kind,
  target_path: r.target_path,
  op: r.op,
  section: r.section,
  text: r.text,
  target_key: r.target_key,
  target_text: r.target_text,
  rationale: r.rationale,
  confidence: Number(r.confidence),
  provenance: r.provenance,
  evidence: r.evidence ?? [],
  status: r.status,
  commit_sha: r.commit_sha,
  created_at: new Date(r.created_at).toISOString(),
  decided_at: r.decided_at ? new Date(r.decided_at).toISOString() : null,
});

export class PgProposalStore implements ProposalStore {
  constructor(private readonly sql: Sql) {}

  async create(p: NewProposal): Promise<MemoryProposal> {
    const rows = await this.sql<Row[]>`
      insert into core.memory_proposals
        (id, kind, target_path, op, patch, section, text, target_key, target_text, rationale,
         evidence, confidence, provenance, status, commit_sha, decided_at)
      values (${newProposalId()}, ${p.kind}, ${p.target_path}, ${p.op}, ${p.text}, ${p.section}, ${p.text},
              ${p.target_key}, ${p.target_text}, ${p.rationale}, ${this.sql.json(p.evidence as never)},
              ${p.confidence}, ${p.provenance}, ${p.status}, ${p.commit_sha ?? null},
              ${p.status === 'proposed' ? null : new Date()})
      returning *`;
    return fromRow(rows[0] as Row);
  }

  async get(id: string) {
    const rows = await this.sql<Row[]>`select * from core.memory_proposals where id = ${id}`;
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async list(opts: { status?: MemoryProposal['status'][]; limit?: number } = {}) {
    const limit = Math.min(opts.limit ?? 100, 500);
    const rows = opts.status?.length
      ? await this.sql<Row[]>`
          select * from core.memory_proposals where status = any(${opts.status})
          order by created_at desc, id desc limit ${limit}`
      : await this.sql<Row[]>`
          select * from core.memory_proposals order by created_at desc, id desc limit ${limit}`;
    return rows.map(fromRow);
  }

  async pending() {
    const rows = await this.sql<{ n: number }[]>`
      select count(*)::int as n from core.memory_proposals where status = 'proposed'`;
    return rows[0]?.n ?? 0;
  }

  async update(id: string, patch: ProposalPatch) {
    const rows = await this.sql<Row[]>`
      update core.memory_proposals set
        status = coalesce(${patch.status ?? null}, status),
        commit_sha = coalesce(${patch.commit_sha ?? null}, commit_sha),
        text = coalesce(${patch.text ?? null}, text),
        decided_at = case when ${patch.decided ?? false} then now() else decided_at end
      where id = ${id}
      returning *`;
    return rows[0] ? fromRow(rows[0]) : undefined;
  }
}
