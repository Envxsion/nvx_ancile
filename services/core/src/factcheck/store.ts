/**
 * ------------------------------------------------------------------
 *  Title    |  Fact-check store
 *  Ref      |  DESIGN.md §3.1 (factchecks, claims), §10
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keep every fact-check of an answer, newest first: its
 *           |  status, the verifier used, its claims with evidence and
 *           |  their score breakdown. Older checks are never replaced,
 *           |  so a re-run can show the score before it (previousFor).
 *  How      |  FactcheckStore is what the run handler and the routes
 *           |  use; PgFactcheckStore is real, MemoryFactcheckStore
 *           |  backs tests. finish() writes the claims and the result
 *           |  in one transaction, so a reader never sees half a check.
 * ------------------------------------------------------------------
 */

import type { ClaimCheckInfo, ClaimEvidence, ClaimVerdict, WebReason, WebVia } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { pgSafe } from '../db/json';
import type { ExtractedClaim } from './pipeline';

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
  /** Which model checked it, at what tier, and how it got there (TR3). Absent on checks from before tiers. */
  check?: ClaimCheckInfo;
}

export interface FactcheckRecord {
  id: string;
  message_id: string;
  run_id: string | null;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  confidence: number | null;
  verifier_model_id: string | null;
  scope: {
    notebook_id: string | null;
    web: boolean;
    web_note?: string | null;
    web_reason?: WebReason | null;
    web_cost_usd?: number;
    web_lookups?: WebVia[];
    critical?: boolean;
  };
  error: { code: string; title: string; hint: string } | null;
  claims: StoredClaim[];
  created_at: string;
  finished_at: string | null;
}

/** The claims found in one answer, kept so a check run again reuses them. */
export interface StoredExtraction {
  message_id: string;
  /** sha256 of the answer's text when the claims were found: a changed answer is a miss. */
  answer_sha: string;
  /** Which extraction found them (steps.ts EXTRACTOR_VERSION): a newer one finds them again. */
  version: number;
  claims: ExtractedClaim[];
  created_at: string;
}

export interface FactcheckStore {
  /** The claims kept for a message, if any. */
  extractionFor(messageId: string): Promise<StoredExtraction | undefined>;
  saveExtraction(e: Omit<StoredExtraction, 'created_at'>): Promise<void>;
  create(f: {
    id: string;
    message_id: string;
    run_id: string;
    scope: FactcheckRecord['scope'];
  }): Promise<FactcheckRecord>;
  get(id: string): Promise<FactcheckRecord | undefined>;
  /** The newest fact-check of a message, if any. */
  latestFor(messageId: string): Promise<FactcheckRecord | undefined>;
  /** The newest finished check of a message made before `beforeId`: the score shown beside a re-run. */
  previousFor(messageId: string, beforeId: string): Promise<FactcheckRecord | undefined>;
  finish(
    id: string,
    r: {
      confidence: number | null;
      verifier_model_id: string | null;
      claims: StoredClaim[];
      /** What the web lookups turned out to be (a budget reached, a search that failed, what they cost). */
      scope?: Partial<FactcheckRecord['scope']>;
    },
  ): Promise<void>;
  fail(id: string, error: NonNullable<FactcheckRecord['error']>): Promise<void>;
  /** The person stopped it: ends it as cancelled (the same words as the run), not as a failure. */
  cancel(id: string, error: NonNullable<FactcheckRecord['error']>): Promise<void>;
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
  check_info: ClaimCheckInfo | null;
}

const fromRow = (r: FactcheckRow, claims: StoredClaim[]): FactcheckRecord => ({
  id: r.id,
  message_id: r.message_id,
  run_id: r.run_id,
  status: r.status,
  confidence: r.confidence,
  verifier_model_id: r.verifier_model_id,
  scope: {
    notebook_id: r.scope?.notebook_id ?? null,
    web: r.scope?.web === true,
    web_note: r.scope?.web_note ?? null,
    web_reason: r.scope?.web_reason ?? null,
    ...(r.scope?.web_cost_usd !== undefined && { web_cost_usd: r.scope.web_cost_usd }),
    ...(r.scope?.web_lookups && { web_lookups: r.scope.web_lookups }),
    critical: r.scope?.critical === true,
  },
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
  ...(r.check_info && { check: r.check_info }),
});

export class PgFactcheckStore implements FactcheckStore {
  constructor(private readonly sql: Sql) {}

  async extractionFor(messageId: string) {
    const rows = await this.sql<
      {
        message_id: string;
        answer_sha: string;
        version: number;
        claims: ExtractedClaim[];
        created_at: Date;
      }[]
    >`select * from core.factcheck_extractions where message_id = ${messageId}`;
    const r = rows[0];
    return r ? { ...r, created_at: r.created_at.toISOString() } : undefined;
  }

  async saveExtraction(e: Omit<StoredExtraction, 'created_at'>) {
    await this.sql`
      insert into core.factcheck_extractions (message_id, answer_sha, version, claims)
      values (${e.message_id}, ${e.answer_sha}, ${e.version}, ${this.sql.json(pgSafe(e.claims) as never)})
      on conflict (message_id) do update set answer_sha = excluded.answer_sha, version = excluded.version,
        claims = excluded.claims, created_at = now()`;
  }

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

  async previousFor(messageId: string, beforeId: string) {
    const rows = await this.sql<FactcheckRow[]>`
      select f.* from core.factchecks f, core.factchecks b
      where b.id = ${beforeId} and f.message_id = ${messageId} and f.id <> b.id and f.status = 'done'
        and (f.created_at, f.id) < (b.created_at, b.id)
      order by f.created_at desc, f.id desc limit 1`;
    return this.load(rows[0]);
  }

  async finish(id: string, r: Parameters<FactcheckStore['finish']>[1]) {
    await this.sql.begin(async (tx) => {
      await tx`delete from core.claims where factcheck_id = ${id}`;
      for (const [seq, c] of r.claims.entries()) {
        await tx`
          insert into core.claims (id, factcheck_id, seq, text, char_start, char_end, importance, verdict,
            confidence, support, agreement, retrieval, evidence, rationale, check_info)
          values (${c.id}, ${id}, ${seq}, ${c.text}, ${c.char_start}, ${c.char_end}, ${c.importance},
            ${c.verdict}, ${c.confidence}, ${c.support}, ${c.agreement}, ${c.retrieval},
            ${tx.json(pgSafe(c.evidence) as never)}, ${c.rationale},
            ${c.check ? tx.json(pgSafe(c.check) as never) : null})`;
      }
      await tx`
        update core.factchecks set status = 'done', confidence = ${r.confidence},
          verifier_model_id = ${r.verifier_model_id}, finished_at = now(), error = null,
          scope = coalesce(scope, '{}'::jsonb) || ${tx.json(pgSafe(r.scope ?? {}) as never)}
        where id = ${id}`;
    });
  }

  async fail(id: string, error: NonNullable<FactcheckRecord['error']>) {
    await this.sql`
      update core.factchecks set status = 'failed', error = ${this.sql.json(pgSafe(error) as never)}, finished_at = now()
      where id = ${id}`;
  }

  async cancel(id: string, error: NonNullable<FactcheckRecord['error']>) {
    await this.sql`
      update core.factchecks set status = 'cancelled', error = ${this.sql.json(pgSafe(error) as never)}, finished_at = now()
      where id = ${id}`;
  }
}

/* ---- Memory (unit tests) -------------------------------------------------- */

export class MemoryFactcheckStore implements FactcheckStore {
  readonly rows = new Map<string, FactcheckRecord>();
  readonly extractions = new Map<string, StoredExtraction>();
  private n = 0;

  async extractionFor(messageId: string) {
    const e = this.extractions.get(messageId);
    return e ? structuredClone(e) : undefined;
  }

  async saveExtraction(e: Omit<StoredExtraction, 'created_at'>) {
    this.extractions.set(e.message_id, { ...structuredClone(e), created_at: this.stamp() });
  }
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

  async previousFor(messageId: string, beforeId: string) {
    const before = this.rows.get(beforeId);
    if (!before) return undefined;
    const all = [...this.rows.values()].filter(
      (r) =>
        r.message_id === messageId &&
        r.id !== beforeId &&
        r.status === 'done' &&
        r.created_at < before.created_at,
    );
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
      scope: { ...rec.scope, ...r.scope },
      finished_at: this.stamp(),
      error: null,
    });
  }

  async fail(id: string, error: NonNullable<FactcheckRecord['error']>) {
    const rec = this.rows.get(id);
    if (!rec) return;
    Object.assign(rec, { status: 'failed', error, finished_at: this.stamp() });
  }

  async cancel(id: string, error: NonNullable<FactcheckRecord['error']>) {
    const rec = this.rows.get(id);
    if (!rec) return;
    Object.assign(rec, { status: 'cancelled', error, finished_at: this.stamp() });
  }
}
