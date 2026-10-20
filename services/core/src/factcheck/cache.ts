/**
 * ------------------------------------------------------------------
 *  Title    |  Verdict cache
 *  Ref      |  DESIGN.md D30 · roadmap SI1 · docs/factcheck.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Never pay twice to check the same claim against the
 *           |  same evidence. A verdict is kept with the tier and the
 *           |  model that made it, and found again by a key.
 *  How      |  key = sha256(normalised claim, sorted source
 *           |  fingerprints, mode). A source that changed has a new
 *           |  fingerprint, so its old verdict is never found.
 *           |  ttl: source-backed until a fingerprint changes (it is
 *           |  in the key), web-only 7 days, common knowledge 90 days.
 *           |  scope: a verdict stays in the notebook that made it.
 *           |  "Share these checks" moves a notebook's verdicts that
 *           |  did not use your sources to scope global; "Stop sharing"
 *           |  moves them back. A shared notebook reads global
 *           |  verdicts too. Verdicts checked against your own sources
 *           |  are never global. A private notebook shares only when
 *           |  privacy.allows('verdict_cache_global') says so.
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import type { ClaimEvidence, ModelTier, PrivacyCapability } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { pgSafe } from '../db/json';
import type { VerifierVerdict } from './score';

export type CacheBasis = 'sources' | 'web' | 'general';
export type CacheScope = 'notebook' | 'global';

/** What is worth keeping of one check. */
export interface CachedVerdict {
  stance: VerifierVerdict;
  rationale: string;
  evidence: ClaimEvidence[];
  confidence: number | null;
  general: boolean;
}

export interface CacheEntry {
  notebook_id: string;
  key: string;
  scope: CacheScope;
  verdict: CachedVerdict;
  tier: ModelTier | null;
  model_id: string | null;
  mode: string;
  ttl_kind: 'source' | 'web' | 'rules';
  source_backed: boolean;
  created_at: string;
  expires_at: string | null;
}

export interface VerdictCacheStore {
  get(notebookId: string, key: string): Promise<CacheEntry | undefined>;
  getGlobal(key: string): Promise<CacheEntry | undefined>;
  put(e: CacheEntry): Promise<void>;
  /** Move a notebook's entries to `scope`; only those that never used your sources go global. Returns how many. */
  setScope(notebookId: string, scope: CacheScope): Promise<number>;
  count(notebookId: string): Promise<number>;
  /** Forget a notebook's entries (it was deleted, or its sources were purged). */
  clear(notebookId: string): Promise<void>;
}

/* ---- Keys and lifetimes ------------------------------------------------------ */

const DAY_MS = 86_400_000;
export const WEB_TTL_MS = 7 * DAY_MS;
export const RULES_TTL_MS = 90 * DAY_MS;

/** Case, spacing and end punctuation do not change a claim. */
export const normaliseClaim = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.!?;:,]+$/g, '')
    .trim();

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * What identifies a piece of evidence. Your sources by their passage text (an edited source is a new
 * fingerprint); the web by address, so a re-worded snippet does not defeat a week of reuse.
 */
export function fingerprint(e: {
  origin?: string | undefined;
  ref: string;
  quote: string;
  text?: string;
}): string {
  return e.origin === 'web'
    ? sha(`web|${e.ref}`).slice(0, 16)
    : sha(`src|${e.ref}|${e.text ?? e.quote}`).slice(0, 16);
}

/** How the evidence backs a verdict decides how long it lives and who may reuse it. */
export function basisOf(evidence: { origin?: string | undefined }[]): CacheBasis {
  if (evidence.some((e) => (e.origin ?? 'source') === 'source')) return 'sources';
  return evidence.length ? 'web' : 'general';
}

export function cacheKey(a: {
  claim: string;
  evidence: { origin?: string | undefined; ref: string; quote: string; text?: string }[];
  critical: boolean;
}): { key: string; basis: CacheBasis; mode: string } {
  const basis = basisOf(a.evidence);
  const mode = `${basis}${a.critical ? '+critical' : ''}`;
  const prints = a.evidence.map(fingerprint).sort();
  return { key: sha([normaliseClaim(a.claim), prints.join(','), mode].join('\n')), basis, mode };
}

const TTL: Record<CacheBasis, { kind: CacheEntry['ttl_kind']; ms: number | null }> = {
  sources: { kind: 'source', ms: null },
  web: { kind: 'web', ms: WEB_TTL_MS },
  general: { kind: 'rules', ms: RULES_TTL_MS },
};

/* ---- The service ------------------------------------------------------------- */

export interface PrivacyGate {
  allows(capability: PrivacyCapability, ctx: { notebookId?: string | null }): Promise<boolean>;
}

export interface Hit {
  entry: CacheEntry;
  scope: CacheScope;
}

export class VerdictCache {
  constructor(
    private readonly store: VerdictCacheStore,
    private readonly privacy?: PrivacyGate,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** May this notebook give verdicts to, and take them from, the global cache right now? */
  async mayShare(notebookId: string): Promise<boolean> {
    if (!notebookId) return false;
    return this.privacy ? await this.privacy.allows('verdict_cache_global', { notebookId }) : true;
  }

  /** An earlier verdict for this claim and evidence: this notebook's, else (when sharing) the global one. */
  async lookup(a: {
    notebookId: string | null;
    shared: boolean;
    claim: string;
    evidence: Parameters<typeof cacheKey>[0]['evidence'];
    critical: boolean;
  }): Promise<Hit | null> {
    const nb = a.notebookId ?? '';
    const { key, basis } = cacheKey(a);
    const live = (e: CacheEntry | undefined) =>
      e && (!e.expires_at || new Date(e.expires_at).getTime() > this.now().getTime()) ? e : undefined;
    const own = live(await this.store.get(nb, key));
    if (own) return { entry: own, scope: own.scope };
    // Only a claim checked without your sources can come from anywhere else.
    if (basis === 'sources' || !a.shared || !(await this.mayShare(nb))) return null;
    const global = live(await this.store.getGlobal(key));
    return global ? { entry: global, scope: 'global' } : null;
  }

  /** Keep a verdict. It is global at once when the notebook shares and the verdict never used your sources. */
  async record(a: {
    notebookId: string | null;
    shared: boolean;
    claim: string;
    evidence: Parameters<typeof cacheKey>[0]['evidence'];
    critical: boolean;
    verdict: CachedVerdict;
    tier: ModelTier | null;
    modelId: string | null;
  }): Promise<void> {
    const nb = a.notebookId ?? '';
    const { key, basis, mode } = cacheKey(a);
    const ttl = TTL[basis];
    const now = this.now();
    const global = basis !== 'sources' && a.shared && (await this.mayShare(nb));
    await this.store.put({
      notebook_id: nb,
      key,
      scope: global ? 'global' : 'notebook',
      verdict: a.verdict,
      tier: a.tier,
      model_id: a.modelId,
      mode,
      ttl_kind: ttl.kind,
      source_backed: basis === 'sources',
      created_at: now.toISOString(),
      expires_at: ttl.ms === null ? null : new Date(now.getTime() + ttl.ms).toISOString(),
    });
  }

  /** "Share these checks with all notebooks" (shared) and "Stop sharing". Returns how many verdicts moved. */
  async setShared(notebookId: string, shared: boolean): Promise<number> {
    return this.store.setScope(notebookId, shared ? 'global' : 'notebook');
  }

  entries(notebookId: string): Promise<number> {
    return this.store.count(notebookId);
  }

  clear(notebookId: string): Promise<void> {
    return this.store.clear(notebookId);
  }
}

/* ---- Postgres ---------------------------------------------------------------- */

interface Row {
  notebook_id: string;
  key: string;
  scope: CacheScope;
  verdict: CachedVerdict;
  tier: ModelTier | null;
  model_id: string | null;
  mode: string;
  ttl_kind: CacheEntry['ttl_kind'];
  source_backed: boolean;
  created_at: Date;
  expires_at: Date | null;
}

const fromRow = (r: Row): CacheEntry => ({
  ...r,
  created_at: r.created_at.toISOString(),
  expires_at: r.expires_at ? r.expires_at.toISOString() : null,
});

export class PgVerdictCacheStore implements VerdictCacheStore {
  constructor(private readonly sql: Sql) {}

  async get(notebookId: string, key: string) {
    const rows = await this.sql<Row[]>`
      select * from core.verdict_cache where notebook_id = ${notebookId} and key = ${key}`;
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async getGlobal(key: string) {
    const rows = await this.sql<Row[]>`
      select * from core.verdict_cache where scope = 'global' and key = ${key}
      order by created_at desc limit 1`;
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async put(e: CacheEntry) {
    await this.sql`
      insert into core.verdict_cache
        (notebook_id, key, scope, verdict, tier, model_id, mode, ttl_kind, source_backed, created_at, expires_at)
      values (${e.notebook_id}, ${e.key}, ${e.scope}, ${this.sql.json(pgSafe(e.verdict) as never)}, ${e.tier},
        ${e.model_id}, ${e.mode}, ${e.ttl_kind}, ${e.source_backed}, ${e.created_at}, ${e.expires_at})
      on conflict (notebook_id, key) do update set scope = excluded.scope, verdict = excluded.verdict,
        tier = excluded.tier, model_id = excluded.model_id, mode = excluded.mode, ttl_kind = excluded.ttl_kind,
        source_backed = excluded.source_backed, created_at = excluded.created_at, expires_at = excluded.expires_at`;
  }

  async setScope(notebookId: string, scope: CacheScope) {
    const rows =
      scope === 'global'
        ? await this.sql`update core.verdict_cache set scope = 'global'
            where notebook_id = ${notebookId} and source_backed = false and scope <> 'global' returning key`
        : await this.sql`update core.verdict_cache set scope = 'notebook'
            where notebook_id = ${notebookId} and scope <> 'notebook' returning key`;
    return rows.length;
  }

  async count(notebookId: string) {
    const rows = await this.sql<{ n: number }[]>`
      select count(*)::int as n from core.verdict_cache where notebook_id = ${notebookId}`;
    return rows[0]?.n ?? 0;
  }

  async clear(notebookId: string) {
    await this.sql`delete from core.verdict_cache where notebook_id = ${notebookId}`;
  }
}

/* ---- Memory (unit tests) ----------------------------------------------------- */

export class MemoryVerdictCacheStore implements VerdictCacheStore {
  readonly rows = new Map<string, CacheEntry>();
  private id = (nb: string, key: string) => `${nb}\u0000${key}`;

  async get(notebookId: string, key: string) {
    const r = this.rows.get(this.id(notebookId, key));
    return r ? structuredClone(r) : undefined;
  }

  async getGlobal(key: string) {
    const all = [...this.rows.values()].filter((r) => r.scope === 'global' && r.key === key);
    all.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return all[0] ? structuredClone(all[0]) : undefined;
  }

  async put(e: CacheEntry) {
    this.rows.set(this.id(e.notebook_id, e.key), structuredClone(e));
  }

  async setScope(notebookId: string, scope: CacheScope) {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.notebook_id !== notebookId || r.scope === scope) continue;
      if (scope === 'global' && r.source_backed) continue;
      r.scope = scope;
      n++;
    }
    return n;
  }

  async count(notebookId: string) {
    return [...this.rows.values()].filter((r) => r.notebook_id === notebookId).length;
  }

  async clear(notebookId: string) {
    for (const [k, r] of this.rows) if (r.notebook_id === notebookId) this.rows.delete(k);
  }
}
