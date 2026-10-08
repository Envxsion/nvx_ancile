/**
 * ------------------------------------------------------------------
 *  Title    |  Fact-check store
 *  Ref      |  DESIGN.md §3.1 (factchecks, claims), §10
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keep every fact-check of an answer, newest first: its
 *           |  status, the verifier used, its claims with evidence and
 *           |  their score breakdown.
 *  How      |  FactcheckStore is what the run handler and the routes
 *           |  use; PgFactcheckStore is real, MemoryFactcheckStore
 *           |  backs tests. finish() writes the claims and the result
 *           |  in one transaction, so a reader never sees half a check.
 * ------------------------------------------------------------------
 */

import type { ClaimEvidence, ClaimVerdict } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { pgSafe } from '../db/json';

export interface StoredClaim {
  id: string;
  text: string;
  char_start: number;
  char_end: number;
  importance: number;
  verdict: ClaimVerdict;
  confidence: number;
  support: number;
  agreement: number;
  retrieval: number;
  evidence: ClaimEvidence[];
  rationale: string;
}

export interface FactcheckRecord {
  id: string;
  message_id: string;
  run_id: string | null;
  status: 'running' | 'done' | 'failed';
  confidence: number | null;
  verifier_model_id: string | null;
  scope: { notebook_id: string | null; web: boolean };
  error: { code: string; title: string; hint: string } | null;
  claims: StoredClaim[];
  created_at: string;
  finished_at: string | null;
}

export interface FactcheckStore {
  create(f: {
    id: string;
    message_id: string;
    run_id: string;
    scope: FactcheckRecord['scope'];
  }): Promise<FactcheckRecord>;
  get(id: string): Promise<FactcheckRecord | undefined>;
  /** The newest fact-check of a message, if any. */
  latestFor(messageId: string): Promise<FactcheckRecord | undefined>;
  finish(
    id: string,
    r: { confidence: number | null; verifier_model_id: string | null; claims: StoredClaim[] },
  ): Promise<void>;
  fail(id: string, error: NonNullable<FactcheckRecord['error']>): Promise<void>;
}

/* ---- Postgres ------------------------------------------------------------- */

interface FactcheckRow {
  id: string;
  message_id: string;
  run_id: string | null;
  status: FactcheckRecord['status'];
  confidence: number | null;
  verifier_model_id: string | null;
  scope: Partial<FactcheckRecord['scope']> | null;
  error: FactcheckRecord['error'];
  created_at: Date;
  finished_at: Date | null;
}

interface ClaimRow {
  id: string;
  text: string;
  char_start: number;
  char_end: number;
  importance: number;
  verdict: ClaimVerdict;
  confidence: number;
  support: number;
  agreement: number;
  retrieval: number;
  evidence: ClaimEvidence[] | null;
  rationale: string | null;
}

const fromRow = (r: FactcheckRow, claims: StoredClaim[]): FactcheckRecord => ({
  id: r.id,
  message_id: r.message_id,
  run_id: r.run_id,
  status: r.status,
  confidence: r.confidence,
  verifier_model_id: r.verifier_model_id,
  scope: { notebook_id: r.scope?.notebook_id ?? null, web: r.scope?.web === true },
  error: r.error,
  claims,
  created_at: r.created_at.toISOString(),
  finished_at: r.finished_at ? r.finished_at.toISOString() : null,
});

const claimFromRow = (r: ClaimRow): StoredClaim => ({
  id: r.id,
  text: r.text,
  char_start: r.char_start,
  char_end: r.char_end,
  importance: r.importance,
  verdict: r.verdict,
  confidence: r.confidence,
  support: r.support,
  agreement: r.agreement,
  retrieval: r.retrieval,
  evidence: r.evidence ?? [],
  rationale: r.rationale ?? '',
});

export class PgFactcheckStore implements FactcheckStore {
  constructor(private readonly sql: Sql) {}

  private async load(row: FactcheckRow | undefined) {
    if (!row) return undefined;
    const claims = await this.sql<ClaimRow[]>`
      select * from core.claims where factcheck_id = ${row.id} order by seq, char_start`;
    return fromRow(row, claims.map(claimFromRow));
  }

  async create(f: Parameters<FactcheckStore['create']>[0]) {
    const rows = await this.sql<FactcheckRow[]>`
      insert into core.factchecks (id, message_id, status, run_id, scope)
      values (${f.id}, ${f.message_id}, 'running', ${f.run_id}, ${this.sql.json(pgSafe(f.scope) as never)})
      returning *`;
    return fromRow(rows[0] as FactcheckRow, []);
  }

  async get(id: string) {
    const rows = await this.sql<FactcheckRow[]>`select * from core.factchecks where id = ${id}`;
    return this.load(rows[0]);
  }

  async latestFor(messageId: string) {
    const rows = await this.sql<FactcheckRow[]>`
      select * from core.factchecks where message_id = ${messageId}
      order by created_at desc, id desc limit 1`;
    return this.load(rows[0]);
  }

  async finish(id: string, r: Parameters<FactcheckStore['finish']>[1]) {
    await this.sql.begin(async (tx) => {
      await tx`delete from core.claims where factcheck_id = ${id}`;
      for (const [seq, c] of r.claims.entries()) {
        await tx`
          insert into core.claims (id, factcheck_id, seq, text, char_start, char_end, importance, verdict,
            confidence, support, agreement, retrieval, evidence, rationale)
          values (${c.id}, ${id}, ${seq}, ${c.text}, ${c.char_start}, ${c.char_end}, ${c.importance},
            ${c.verdict}, ${c.confidence}, ${c.support}, ${c.agreement}, ${c.retrieval},
            ${tx.json(pgSafe(c.evidence) as never)}, ${c.rationale})`;
      }
      await tx`
        update core.factchecks set status = 'done', confidence = ${r.confidence},
          verifier_model_id = ${r.verifier_model_id}, finished_at = now(), error = null
        where id = ${id}`;
    });
  }

  async fail(id: string, error: NonNullable<FactcheckRecord['error']>) {
    await this.sql`
      update core.factchecks set status = 'failed', error = ${this.sql.json(pgSafe(error) as never)}, finished_at = now()
      where id = ${id}`;
  }
}

/* ---- Memory (unit tests) -------------------------------------------------- */

export class MemoryFactcheckStore implements FactcheckStore {
  readonly rows = new Map<string, FactcheckRecord>();
  private n = 0;
  private stamp() {
    // Strictly increasing, so "newest" is well defined within one millisecond.
    return new Date(Date.UTC(2026, 0, 1) + ++this.n).toISOString();
  }

  async create(f: Parameters<FactcheckStore['create']>[0]) {
    const rec: FactcheckRecord = {
      id: f.id,
      message_id: f.message_id,
      run_id: f.run_id,
      status: 'running',
      confidence: null,
      verifier_model_id: null,
      scope: f.scope,
      error: null,
      claims: [],
      created_at: this.stamp(),
      finished_at: null,
    };
    this.rows.set(f.id, rec);
    return structuredClone(rec);
  }

  async get(id: string) {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : undefined;
  }

  async latestFor(messageId: string) {
    const all = [...this.rows.values()].filter((r) => r.message_id === messageId);
    all.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return all[0] ? structuredClone(all[0]) : undefined;
  }

  async finish(id: string, r: Parameters<FactcheckStore['finish']>[1]) {
    const rec = this.rows.get(id);
    if (!rec) return;
    Object.assign(rec, {
      status: 'done',
      confidence: r.confidence,
      verifier_model_id: r.verifier_model_id,
      claims: structuredClone(r.claims),
      finished_at: this.stamp(),
      error: null,
    });
  }

  async fail(id: string, error: NonNullable<FactcheckRecord['error']>) {
    const rec = this.rows.get(id);
    if (!rec) return;
    Object.assign(rec, { status: 'failed', error, finished_at: this.stamp() });
  }
}
