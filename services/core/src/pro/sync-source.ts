/**
 * ------------------------------------------------------------------
 *  Title    |  Pro seam: what sync can carry
 *  Ref      |  DESIGN.md §9
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The workspace as records Pro's sync can move between a
 *           |  person's computers: notebooks, flows, threads, messages,
 *           |  notes and Cockpit preferences. Core owns the data; Pro
 *           |  only seals and carries it.
 *  How      |  Each collection reads rows changed since a time and
 *           |  writes rows that arrived, in an order that respects the
 *           |  foreign keys (notebooks before threads before messages).
 *           |  Every install has its own workspace and owner, so rows
 *           |  are written under this one's. Deletions are soft
 *           |  (deleted_at), so they travel like any other change.
 *  Note     |  Device-local things never travel: licence, keys, usage
 *           |  statistics, runs, approvals, logs.
 * ------------------------------------------------------------------
 */

import type { Sql } from 'postgres';
import type { ProSyncSource } from './types';

type Row = Record<string, unknown>;

interface Collection {
  /** Rows changed since `since` (ISO), newest state each. */
  changes(since: string | null): Promise<{ id: string; updatedAt: string; data: Row }[]>;
  /** Upsert rows that arrived; returns how many were written. */
  apply(items: { id: string; data: Row; deleted: boolean }[]): Promise<number>;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? ''));

/** Columns a remote row may set, per table (never ids of this install's workspace or owner). */
const COLS = {
  notebooks: [
    'id',
    'title',
    'slug',
    'description',
    'icon',
    'color',
    'memory_path',
    'settings',
    'archived_at',
    'created_at',
    'updated_at',
    'pinned_at',
    'deleted_at',
  ],
  flows: [
    'id',
    'scope',
    'scope_ref',
    'name',
    'description',
    'graph',
    'version',
    'active',
    'published_version',
    'created_at',
    'updated_at',
    'deleted_at',
  ],
  threads: [
    'id',
    'notebook_id',
    'title',
    'title_source',
    'root_message_id',
    'active_head_id',
    'settings',
    'pinned_tldr_id',
    'archived_at',
    'created_at',
    'updated_at',
    'deleted_at',
    'pinned_at',
  ],
  messages: [
    'id',
    'thread_id',
    'parent_id',
    'role',
    'parts',
    'model_id',
    'requested_model_id',
    'status',
    'edit_of_id',
    'provenance',
    'usage',
    'created_at',
    'deleted_at',
  ],
  notes: [
    'id',
    'notebook_id',
    'kind',
    'title',
    'content_md',
    'from_message_id',
    'from_insight_id',
    'created_at',
    'updated_at',
    'pinned_at',
    'deleted_at',
  ],
} as const;

const JSONB = new Set(['settings', 'graph', 'parts', 'provenance', 'usage']);

function upsert(sql: Sql, table: keyof typeof COLS, row: Row, extra: Row): Promise<unknown> {
  const cols = [...COLS[table].filter((c) => c in row), ...Object.keys(extra)];
  const vals = cols.map((c) => {
    const v = c in extra ? extra[c] : row[c];
    return JSONB.has(c) && v !== null && v !== undefined ? JSON.stringify(v) : (v ?? null);
  });
  const ph = cols.map((c, i) => (JSONB.has(c) ? `$${i + 1}::text::jsonb` : `$${i + 1}`));
  const set = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`);
  return sql.unsafe(
    `insert into core.${table} (${cols.join(', ')}) values (${ph.join(', ')})
     on conflict (id) do update set ${set.join(', ')}`,
    vals as never[],
  );
}

export function sqlSyncSource(sql: Sql, owner: { userId: string; workspaceId: string }): ProSyncSource {
  const ws = { workspace_id: owner.workspaceId };
  const table = (name: keyof typeof COLS, where: string, extra: Row = {}): Collection => ({
    async changes(since) {
      const rows = await sql.unsafe<Row[]>(`select * from core.${name} where ${where} order by 1`, [
        since ?? '1970-01-01T00:00:00Z',
      ] as never[]);
      return rows.map((r) => ({
        id: String(r.id),
        updatedAt: iso(r.updated_at ?? r.deleted_at ?? r.created_at),
        data: Object.fromEntries(COLS[name].filter((c) => c in r).map((c) => [c, r[c]])),
      }));
    },
    async apply(items) {
      let n = 0;
      for (const it of items) {
        await upsert(
          sql,
          name,
          it.deleted ? { ...it.data, deleted_at: new Date().toISOString() } : it.data,
          extra,
        );
        n++;
      }
      return n;
    },
  });

  const collections: Record<string, Collection> = {
    notebooks: table('notebooks', 'updated_at > $1 or deleted_at > $1', ws),
    flows: {
      ...table('flows', 'updated_at > $1 or deleted_at > $1', ws),
      async changes(since) {
        const flows = await table('flows', 'updated_at > $1 or deleted_at > $1').changes(since);
        // A flow travels with its versions: "the published one" must exist on arrival.
        for (const f of flows) {
          f.data.versions = await sql.unsafe<Row[]>(
            'select version, name, graph, message, created_at from core.flow_versions where flow_id = $1 order by version',
            [f.id] as never[],
          );
        }
        return flows;
      },
      async apply(items) {
        let n = 0;
        for (const it of items) {
          const { versions, ...flow } = it.data as Row & { versions?: Row[] };
          await upsert(
            sql,
            'flows',
            it.deleted ? { ...flow, deleted_at: new Date().toISOString() } : flow,
            ws,
          );
          for (const v of versions ?? [])
            await sql.unsafe(
              `insert into core.flow_versions (flow_id, version, name, graph, message, created_at)
               values ($1, $2, $3, $4::text::jsonb, $5, $6) on conflict do nothing`,
              [it.id, v.version, v.name, JSON.stringify(v.graph), v.message ?? null, v.created_at] as never[],
            );
          n++;
        }
        return n;
      },
    },
    threads: table('threads', 'updated_at > $1 or deleted_at > $1', ws),
    // Messages have no updated_at: a day's look-back catches answers that
    // finished after they were created; unchanged ones are skipped by hash.
    messages: {
      ...table(
        'messages',
        "(created_at > ($1::timestamptz - interval '1 day') or deleted_at > $1) and status in ('complete', 'error', 'stopped')",
      ),
      async apply(items) {
        // Parents before children: a reply never arrives before its question.
        const sorted = [...items].sort((a, b) =>
          iso(a.data.created_at).localeCompare(iso(b.data.created_at)),
        );
        let n = 0;
        for (const it of sorted) {
          await upsert(
            sql,
            'messages',
            it.deleted ? { ...it.data, deleted_at: new Date().toISOString() } : it.data,
            {},
          );
          n++;
        }
        return n;
      },
    },
    notes: table('notes', 'updated_at > $1 or deleted_at > $1'),
    preferences: {
      async changes(since) {
        const rows = await sql.unsafe<Row[]>(
          'select key, value, updated_at from core.ui_state where user_id = $1 and updated_at > $2',
          [owner.userId, since ?? '1970-01-01T00:00:00Z'] as never[],
        );
        return rows.map((r) => ({
          id: String(r.key),
          updatedAt: iso(r.updated_at),
          data: { value: r.value },
        }));
      },
      async apply(items) {
        for (const it of items)
          await sql.unsafe(
            `insert into core.ui_state (user_id, key, value, updated_at) values ($1, $2, $3::text::jsonb, now())
             on conflict (user_id, key) do update set value = excluded.value, updated_at = now()`,
            [owner.userId, it.id, JSON.stringify((it.data as { value: unknown }).value)] as never[],
          );
        return items.length;
      },
    },
  };

  return {
    // Applied in this order, so foreign keys always find their rows.
    collections: ['notebooks', 'flows', 'threads', 'messages', 'notes', 'preferences'],
    changes: (c, since) => collections[c]?.changes(since) ?? Promise.resolve([]),
    apply: (c, items) => collections[c]?.apply(items as never) ?? Promise.resolve(0),
  };
}
