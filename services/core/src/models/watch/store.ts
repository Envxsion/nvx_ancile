/**
 * ------------------------------------------------------------------
 *  Title    |  Model watch storage
 *  Ref      |  roadmap MD4, MD5 · migration 0033
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keep what the daily checks saw (core.model_watch) and
 *           |  the changes they found (core.model_changes).
 *  How      |  PgWatchStore in Postgres, MemoryWatchStore for tests.
 *           |  A model row is never deleted: a retired model stays so
 *           |  its id keeps resolving and is never offered as new
 *           |  twice. Changes keep the newest 200, and drop seen ones
 *           |  older than 30 days on each run.
 * ------------------------------------------------------------------
 */
import type { ModelChange, ModelTier, WatchedModel } from '@nvx/contracts';
import type { Sql } from 'postgres';

/** A watched model plus what only Core needs. */
export interface StoredModel extends WatchedModel {
  /** The list said what the model can do (so a missing ability means lost, not unknown). */
  caps_known: boolean;
  /** The provider's created_at, to order two models of one version. */
  created_at: string | null;
  /** Successful checks of this provider that did not list it, in a row. */
  missed: number;
  /** The line's display name and tier, so a model the registry does not have yet can still be grouped. */
  line_name: string | null;
  line_tier: ModelTier | null;
}

export const KEEP_CHANGES = 200;
export const KEEP_SEEN_DAYS = 30;

export interface WatchStore {
  rows(): Promise<StoredModel[]>;
  upsert(rows: StoredModel[]): Promise<void>;
  changes(): Promise<ModelChange[]>;
  addChanges(changes: ModelChange[]): Promise<void>;
  /** Mark these seen; returns how many were unseen. */
  markSeen(ids: string[]): Promise<number>;
  /** Drop seen changes older than 30 days, then keep only the newest 200. */
  trim(nowIso: string): Promise<void>;
}

const byNewest = (a: ModelChange, b: ModelChange) =>
  a.at < b.at ? 1 : a.at > b.at ? -1 : b.id < a.id ? -1 : 1;

export class MemoryWatchStore implements WatchStore {
  private readonly models = new Map<string, StoredModel>();
  private list: ModelChange[] = [];

  async rows() {
    return [...this.models.values()].map((r) => structuredClone(r));
  }
  async upsert(rows: StoredModel[]) {
    for (const r of rows) this.models.set(r.id, structuredClone(r));
  }
  async changes() {
    return [...this.list].sort(byNewest).map((c) => structuredClone(c));
  }
  async addChanges(changes: ModelChange[]) {
    this.list.push(...changes.map((c) => structuredClone(c)));
  }
  async markSeen(ids: string[]) {
    const set = new Set(ids);
    let n = 0;
    for (const c of this.list)
      if (set.has(c.id) && !c.seen) {
        c.seen = true;
        n++;
      }
    return n;
  }
  async trim(nowIso: string) {
    const cut = new Date(Date.parse(nowIso) - KEEP_SEEN_DAYS * 86_400_000).toISOString();
    this.list = this.list
      .filter((c) => !(c.seen && c.at < cut))
      .sort(byNewest)
      .slice(0, KEEP_CHANGES);
  }
}

interface ModelRow {
  data: StoredModel;
  missed: number;
}
interface ChangeRow {
  id: string;
  kind: ModelChange['kind'];
  model_id: string;
  line_id: string | null;
  before: unknown;
  after: unknown;
  reason: ModelChange['reason'];
  at: Date;
  seen: boolean;
}

export class PgWatchStore implements WatchStore {
  constructor(private readonly sql: Sql) {}

  async rows(): Promise<StoredModel[]> {
    const rows = await this.sql<ModelRow[]>`select data, missed from core.model_watch`;
    return rows.map((r) => ({ ...r.data, missed: r.missed }));
  }

  async upsert(rows: StoredModel[]): Promise<void> {
    for (const r of rows) {
      const json = this.sql.json(r as never);
      await this.sql`
        insert into core.model_watch (id, provider, data, first_seen, last_seen, missed)
        values (${r.id}, ${r.provider}, ${json}, ${r.first_seen}, ${r.last_seen}, ${r.missed})
        on conflict (id) do update set
          provider = excluded.provider, data = excluded.data,
          last_seen = excluded.last_seen, missed = excluded.missed`;
    }
  }

  async changes(): Promise<ModelChange[]> {
    const rows = await this.sql<ChangeRow[]>`
      select id, kind, model_id, line_id, before, after, reason, at, seen
      from core.model_changes order by at desc, id desc limit ${KEEP_CHANGES}`;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      model_id: r.model_id,
      line_id: r.line_id,
      before: r.before ?? null,
      after: r.after ?? null,
      reason: r.reason,
      at: r.at.toISOString(),
      seen: r.seen,
    }));
  }

  async addChanges(changes: ModelChange[]): Promise<void> {
    for (const c of changes) {
      await this.sql`
        insert into core.model_changes (id, kind, model_id, line_id, before, after, reason, at, seen)
        values (${c.id}, ${c.kind}, ${c.model_id}, ${c.line_id}, ${this.sql.json((c.before ?? null) as never)},
          ${this.sql.json((c.after ?? null) as never)}, ${c.reason}, ${c.at}, ${c.seen})
        on conflict (id) do nothing`;
    }
  }

  async markSeen(ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const r = await this
      .sql`update core.model_changes set seen = true where id in ${this.sql(ids)} and not seen`;
    return r.count;
  }

  async trim(nowIso: string): Promise<void> {
    const cut = new Date(Date.parse(nowIso) - KEEP_SEEN_DAYS * 86_400_000).toISOString();
    await this.sql`delete from core.model_changes where seen and at < ${cut}`;
    await this.sql`
      delete from core.model_changes where id in (
        select id from core.model_changes order by at desc, id desc offset ${KEEP_CHANGES})`;
  }
}
