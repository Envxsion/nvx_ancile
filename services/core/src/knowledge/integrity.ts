/**
 * ------------------------------------------------------------------
 *  Title    |  Source integrity: tombstones and cited passages
 *  Ref      |  ROADMAP.md track G (sources and knowledge) ·
 *           |  docs/sources.md · DESIGN.md §10
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Deleting or re-reading a source must never break an
 *           |  answer that cited it. Answers keep their quoted passage
 *           |  in their own citation_ref parts; this module says what
 *           |  became of each one since: still current, changed, or
 *           |  removed, with the source's name either way.
 *  How      |  A tombstone row (core.source_tombstones) is written when
 *           |  a source is deleted or merged away. A check asks the
 *           |  knowledge service about each passage (its id and the
 *           |  sha256 of its text when cited), then lays the tombstones
 *           |  over the answer, so a removal is known even when the
 *           |  knowledge service is down or has purged the source.
 *  Note     |  A check that cannot reach the knowledge service says
 *           |  "unknown", never "changed": a flag must mean something.
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import type { PassageCheckResponse, PassageState } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { logFor } from '../obs/logger';
import type { KnowledgeClient } from './client';

const log = logFor('source-integrity');

/** sha256 (hex) of a passage's text, exactly as the model was given it. */
export function passageHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/* ---- Tombstones ---------------------------------------------------------- */

export interface SourceTombstone {
  source_id: string;
  workspace_id: string;
  title: string;
  kind: string | null;
  reason: 'deleted' | 'merged';
  merged_into: string | null;
  deleted_at: string;
}

export interface TombstoneStore {
  /** Record (or refresh) one source's tombstone. */
  record(t: Omit<SourceTombstone, 'deleted_at'>): Promise<void>;
  /** The tombstones among these source ids. */
  get(workspaceId: string, sourceIds: string[]): Promise<Map<string, SourceTombstone>>;
}

interface TombstoneRow {
  source_id: string;
  workspace_id: string;
  title: string;
  kind: string | null;
  reason: 'deleted' | 'merged';
  merged_into: string | null;
  deleted_at: Date;
}

export class PgTombstoneStore implements TombstoneStore {
  constructor(private readonly sql: Sql) {}

  async record(t: Omit<SourceTombstone, 'deleted_at'>) {
    await this.sql`
      insert into core.source_tombstones (source_id, workspace_id, title, kind, reason, merged_into)
      values (${t.source_id}, ${t.workspace_id}, ${t.title}, ${t.kind}, ${t.reason}, ${t.merged_into})
      on conflict (source_id) do update set title = excluded.title, kind = excluded.kind,
        reason = excluded.reason, merged_into = excluded.merged_into, deleted_at = now()`;
  }

  async get(workspaceId: string, sourceIds: string[]) {
    const out = new Map<string, SourceTombstone>();
    if (!sourceIds.length) return out;
    const rows = await this.sql<TombstoneRow[]>`
      select * from core.source_tombstones
      where workspace_id = ${workspaceId} and source_id = any(${[...new Set(sourceIds)]})`;
    for (const r of rows) out.set(r.source_id, { ...r, deleted_at: r.deleted_at.toISOString() });
    return out;
  }
}

export class MemoryTombstoneStore implements TombstoneStore {
  readonly rows = new Map<string, SourceTombstone>();
  async record(t: Omit<SourceTombstone, 'deleted_at'>) {
    this.rows.set(t.source_id, { ...t, deleted_at: new Date().toISOString() });
  }
  async get(workspaceId: string, sourceIds: string[]) {
    const out = new Map<string, SourceTombstone>();
    for (const id of sourceIds) {
      const t = this.rows.get(id);
      if (t && t.workspace_id === workspaceId) out.set(id, structuredClone(t));
    }
    return out;
  }
}

/* ---- Checking passages --------------------------------------------------- */

export interface PassageRef {
  /** The chunk or insight id it was cited as. */
  ref: string;
  source_id: string;
  text_sha256: string | null;
}

export interface PassageCheck extends PassageRef {
  state: PassageState;
  source_title: string | null;
  removed_at: string | null;
  merged_into: string | null;
}

export interface SourceIntegrity {
  check(refs: PassageRef[]): Promise<PassageCheck[]>;
}

/** The knowledge service holds at most this many refs per request (PassageCheckRequest). */
const BATCH = 500;

export function sourceIntegrity(deps: {
  workspaceId: string;
  tombstones: TombstoneStore;
  kn?: Pick<KnowledgeClient, 'post'> | undefined;
}): SourceIntegrity {
  return {
    async check(refs) {
      if (!refs.length) return [];
      const tombs = await deps.tombstones
        .get(
          deps.workspaceId,
          refs.map((r) => r.source_id),
        )
        .catch((err) => {
          log.warn({ err }, 'tombstones could not be read');
          return new Map<string, SourceTombstone>();
        });
      const known = new Map<string, PassageCheckResponse['items'][number]>();
      if (deps.kn) {
        try {
          for (let i = 0; i < refs.length; i += BATCH) {
            const res = await deps.kn.post<PassageCheckResponse>('/passages/check', {
              workspace_id: deps.workspaceId,
              items: refs.slice(i, i + BATCH).map((r) => ({
                ref: r.ref,
                source_id: r.source_id,
                text_sha256: r.text_sha256,
              })),
            });
            for (const it of res.items) known.set(`${it.source_id}\u0000${it.ref}`, it);
          }
        } catch (err) {
          log.warn({ err }, 'cited passages could not be checked; their state is unknown');
        }
      }
      return refs.map((r): PassageCheck => {
        const tomb = tombs.get(r.source_id);
        const k = known.get(`${r.source_id}\u0000${r.ref}`);
        if (tomb || k?.state === 'removed')
          return {
            ...r,
            state: 'removed',
            source_title: tomb?.title ?? k?.source_title ?? null,
            removed_at: tomb?.deleted_at ?? k?.deleted_at ?? null,
            merged_into: tomb?.merged_into ?? null,
          };
        return {
          ...r,
          state: k?.state ?? 'unknown',
          source_title: k?.source_title ?? null,
          removed_at: null,
          merged_into: null,
        };
      });
    },
  };
}
