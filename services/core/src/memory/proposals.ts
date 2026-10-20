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

import type { MemoryImportOrigin, MemoryProposal } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { monotonicFactory } from 'ulid';

// Ids made in the same millisecond still sort in the order they were made. The inbox lists
// newest first by (created_at, id); a plain ulid() breaks a same-millisecond tie at random, so
// one correction that files a lesson and then a preference could list them the wrong way round.
const ulid = monotonicFactory();

export type NewProposal = Omit<MemoryProposal, 'id' | 'created_at' | 'decided_at' | 'commit_sha'> & {
  commit_sha?: string | null;
};

export type ProposalPatch = Partial<
  Pick<
    MemoryProposal,
    | 'status'
    | 'commit_sha'
    | 'text'
    | 'evidence'
    | 'sightings'
    | 'expires_at'
    | 'uncertainty'
    | 'op'
    | 'target_path'
    | 'section'
    | 'target_key'
    | 'target_text'
  >
> & {
  decided?: boolean;
};

/** One import: where its suggestions came from (core.memory_imports). */
export interface ImportRecord {
  id: string;
  origin: MemoryImportOrigin;
  label: string;
  filename: string | null;
  created_at: string;
}

export interface ProposalStore {
  create(p: NewProposal): Promise<MemoryProposal>;
  get(id: string): Promise<MemoryProposal | undefined>;
  list(opts?: { status?: MemoryProposal['status'][]; limit?: number }): Promise<MemoryProposal[]>;
  pending(): Promise<number>;
  /** Watch items (M8) still waiting for a second sighting, oldest first. */
  watching(): Promise<MemoryProposal[]>;
  update(id: string, patch: ProposalPatch): Promise<MemoryProposal | undefined>;
  createImport(r: Omit<ImportRecord, 'id' | 'created_at'>): Promise<ImportRecord>;
  getImport(id: string): Promise<ImportRecord | undefined>;
  /** Newest first. */
  listImports(limit?: number): Promise<ImportRecord[]>;
  /** An import's proposals, oldest first (the order they were in the file). */
  byImport(importId: string): Promise<MemoryProposal[]>;
  /** Applied proposals a commit wrote (an import's accepted entries share one). */
  withCommit(sha: string): Promise<MemoryProposal[]>;
}

export const newProposalId = () => `mpr_${ulid()}`;
export const newImportId = () => `mim_${ulid()}`;

export class MemoryProposalStore implements ProposalStore {
  private rows = new Map<string, MemoryProposal>();
  private imports = new Map<string, ImportRecord>();

  async createImport(r: Omit<ImportRecord, 'id' | 'created_at'>): Promise<ImportRecord> {
    const row: ImportRecord = { ...r, id: newImportId(), created_at: new Date().toISOString() };
    this.imports.set(row.id, row);
    return { ...row };
  }

  async getImport(id: string) {
    const r = this.imports.get(id);
    return r && { ...r };
  }

  async listImports(limit = 50) {
    return [...this.imports.values()]
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async byImport(importId: string) {
    // Insertion order is the order they were in the file.
    return [...this.rows.values()].filter((r) => r.import_id === importId).map((r) => structuredClone(r));
  }

  async withCommit(sha: string) {
    return [...this.rows.values()]
      .filter((r) => r.commit_sha === sha && (r.status === 'applied' || r.status === 'auto_applied'))
      .map((r) => structuredClone(r));
  }

  async create(p: NewProposal): Promise<MemoryProposal> {
    const row: MemoryProposal = {
      ...structuredClone(p),
      id: newProposalId(),
      commit_sha: p.commit_sha ?? null,
      created_at: new Date().toISOString(),
      decided_at: p.status === 'proposed' || p.status === 'watching' ? null : new Date().toISOString(),
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
      .filter((r) => !r.import_id && (!opts.status || opts.status.includes(r.status)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .slice(0, opts.limit ?? 100)
      .map((r) => structuredClone(r));
  }

  async pending() {
    return [...this.rows.values()].filter((r) => r.status === 'proposed' && !r.import_id).length;
  }

  async watching() {
    return [...this.rows.values()]
      .filter((r) => r.status === 'watching')
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .map((r) => structuredClone(r));
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
  import_id?: string | null;
  sightings?: number | null;
  expires_at?: Date | null;
  uncertainty?: string | null;
}

interface ImportRow {
  id: string;
  origin: MemoryImportOrigin;
  label: string;
  filename: string | null;
  created_at: Date;
}

const fromImportRow = (r: ImportRow): ImportRecord => ({
  id: r.id,
  origin: r.origin,
  label: r.label,
  filename: r.filename,
  created_at: new Date(r.created_at).toISOString(),
});

const fromRow = (r: Row): MemoryProposal => ({
  ...(r.import_id && { import_id: r.import_id }),
  ...(r.sightings != null && { sightings: Number(r.sightings) }),
  ...(r.expires_at && { expires_at: new Date(r.expires_at).toISOString() }),
  ...(r.uncertainty && { uncertainty: r.uncertainty }),
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
         evidence, confidence, provenance, status, commit_sha, decided_at, import_id,
         sightings, expires_at, uncertainty)
      values (${newProposalId()}, ${p.kind}, ${p.target_path}, ${p.op}, ${p.text}, ${p.section}, ${p.text},
              ${p.target_key}, ${p.target_text}, ${p.rationale}, ${this.sql.json(p.evidence as never)},
              ${p.confidence}, ${p.provenance}, ${p.status}, ${p.commit_sha ?? null},
              ${p.status === 'proposed' || p.status === 'watching' ? null : new Date()}, ${p.import_id ?? null},
              ${p.sightings ?? 1}, ${p.expires_at ?? null}, ${p.uncertainty ?? null})
      returning *`;
    return fromRow(rows[0] as Row);
  }

  async createImport(r: Omit<ImportRecord, 'id' | 'created_at'>): Promise<ImportRecord> {
    const rows = await this.sql<ImportRow[]>`
      insert into core.memory_imports (id, origin, label, filename)
      values (${newImportId()}, ${r.origin}, ${r.label}, ${r.filename})
      returning *`;
    return fromImportRow(rows[0] as ImportRow);
  }

  async getImport(id: string) {
    const rows = await this.sql<ImportRow[]>`select * from core.memory_imports where id = ${id}`;
    return rows[0] ? fromImportRow(rows[0]) : undefined;
  }

  async listImports(limit = 50) {
    const rows = await this.sql<ImportRow[]>`
      select * from core.memory_imports order by created_at desc, id desc limit ${Math.min(limit, 200)}`;
    return rows.map(fromImportRow);
  }

  async byImport(importId: string) {
    const rows = await this.sql<Row[]>`
      select * from core.memory_proposals where import_id = ${importId} order by created_at, id`;
    return rows.map(fromRow);
  }

  async withCommit(sha: string) {
    const rows = await this.sql<Row[]>`
      select * from core.memory_proposals
      where commit_sha = ${sha} and status in ('applied', 'auto_applied')`;
    return rows.map(fromRow);
  }

  async get(id: string) {
    const rows = await this.sql<Row[]>`select * from core.memory_proposals where id = ${id}`;
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async list(opts: { status?: MemoryProposal['status'][]; limit?: number } = {}) {
    const limit = Math.min(opts.limit ?? 100, 500);
    const rows = opts.status?.length
      ? await this.sql<Row[]>`
          select * from core.memory_proposals where status = any(${opts.status}) and import_id is null
          order by created_at desc, id desc limit ${limit}`
      : await this.sql<Row[]>`
          select * from core.memory_proposals where import_id is null order by created_at desc, id desc limit ${limit}`;
    return rows.map(fromRow);
  }

  async pending() {
    const rows = await this.sql<{ n: number }[]>`
      select count(*)::int as n from core.memory_proposals where status = 'proposed' and import_id is null`;
    return rows[0]?.n ?? 0;
  }

  async watching() {
    const rows = await this.sql<Row[]>`
      select * from core.memory_proposals where status = 'watching' order by created_at, id`;
    return rows.map(fromRow);
  }

  async update(id: string, patch: ProposalPatch) {
    const rows = await this.sql<Row[]>`
      update core.memory_proposals set
        status = coalesce(${patch.status ?? null}, status),
        commit_sha = coalesce(${patch.commit_sha ?? null}, commit_sha),
        text = coalesce(${patch.text ?? null}, text),
        evidence = coalesce(${patch.evidence ? this.sql.json(patch.evidence as never) : null}, evidence),
        sightings = coalesce(${patch.sightings ?? null}, sightings),
        expires_at = case when ${patch.expires_at !== undefined} then ${patch.expires_at ?? null}::timestamptz else expires_at end,
        uncertainty = case when ${patch.uncertainty !== undefined} then ${patch.uncertainty ?? null} else uncertainty end,
        op = coalesce(${patch.op ?? null}, op),
        target_path = coalesce(${patch.target_path ?? null}, target_path),
        section = coalesce(${patch.section ?? null}, section),
        target_key = case when ${patch.target_key !== undefined} then ${patch.target_key ?? null} else target_key end,
        target_text = case when ${patch.target_text !== undefined} then ${patch.target_text ?? null} else target_text end,
        decided_at = case when ${patch.decided ?? false} then now() else decided_at end
      where id = ${id}
      returning *`;
    return rows[0] ? fromRow(rows[0]) : undefined;
  }
}
