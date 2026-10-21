/**
 * ------------------------------------------------------------------
 *  Title    |  Pro seam: what sync can carry
 *  Ref      |  DESIGN.md §9 · docs/scopes.md (Sync)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  The workspace as records Pro's sync can move between a
 *           |  person's computers: notebooks, flows, threads, messages,
 *           |  notes and Cockpit preferences. Core owns the data and
 *           |  the scopes; Pro only seals and carries it.
 *  How      |  Each collection reads rows changed since a time and
 *           |  writes rows that arrived, in an order that respects the
 *           |  foreign keys (notebooks before threads before messages).
 *           |  Every install has its own workspace and owner, so rows
 *           |  are written under this one's. Deletions are soft
 *           |  (deleted_at) and travel without their content.
 *           |  Anything in a notebook or thread whose scope keeps data
 *           |  on this machine (private, or data leaving switched off)
 *           |  is handed over as `local`, without its data, and is
 *           |  never written from another computer. Copies another
 *           |  computer withdrew are marked deleted and emptied (a
 *           |  thread's summaries and drafts go with it).
 *  Note     |  Device-local things never travel: licence, keys, usage
 *           |  statistics, runs, approvals, logs, scopes, and the
 *           |  Cockpit settings that belong to this device
 *           |  (DEVICE_PREFS: zoom, custom CSS, panel widths…). Of the
 *           |  UI state only "prefs" and "help" are about you; the rest
 *           |  (scroll positions, open panels) is about this screen.
 * ------------------------------------------------------------------
 */

import { DEVICE_PREFS, withoutDevicePrefs } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { getEffectiveScope, keepsLocal } from '../scopes';
import type { ProSyncChange, ProSyncSource } from './types';

type Row = Record<string, unknown>;

interface Local {
  notebooks: Set<string>;
  threads: Set<string>;
}

interface Collection {
  /** One row as it is now, or null. */
  read?(id: string): Promise<Row | null>;
  /** Rows changed since `since` (ISO), newest state each; local ones without data. */
  changes(since: string | null, local: Local): Promise<ProSyncChange[]>;
  /** Write rows that arrived; returns how many were written. */
  apply(items: { id: string; data: Row; deleted: boolean }[]): Promise<number>;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? ''));

/** What a synced message stands for in the trace column: no trace on this computer. */
const NO_TRACE = '0'.repeat(32);

/** UI state keys that are about you, not this screen: the only ones that travel. */
export const SYNCED_UI_KEYS: readonly string[] = ['prefs', 'help'];

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
type Table = keyof typeof COLS;

/**
 * What a withdrawn copy keeps: nothing anyone wrote. Ids and times stay, so
 * rows that point at it still do; the row itself is deleted.
 */
const EMPTIED: Record<Table, string> = {
  notebooks: `title = '', slug = id, description = null, memory_path = 'notebooks/' || id, settings = '{}'`,
  threads: `title = '', settings = '{}', pinned_tldr_id = null`,
  messages: `parts = '[]', provenance = '{}', usage = null`,
  notes: `title = '', content_md = ''`,
  flows: `name = '', description = '', graph = '{}', active = false`,
};

/** Tables with a workspace column: only this install's rows are read or touched. */
const IN_WORKSPACE = new Set<Table>(['notebooks', 'threads', 'flows']);

const JSONB = new Set(['settings', 'graph', 'parts', 'provenance', 'usage']);

function upsert(sql: Sql, table: Table, row: Row, extra: Row, insertOnly: Row = {}): Promise<unknown> {
  const cols = [...COLS[table].filter((c) => c in row), ...Object.keys(extra)];
  const all = [...cols, ...Object.keys(insertOnly).filter((c) => !cols.includes(c))];
  const vals = all.map((c) => {
    const v = c in extra ? extra[c] : c in row ? row[c] : insertOnly[c];
    return JSONB.has(c) && v !== null && v !== undefined ? JSON.stringify(v) : (v ?? null);
  });
  const ph = all.map((c, i) => (JSONB.has(c) ? `$${i + 1}::text::jsonb` : `$${i + 1}`));
  // Insert-only columns (a message's trace) fill a row new here, never overwrite one.
  const set = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`);
  return sql.unsafe(
    `insert into core.${table} (${all.join(', ')}) values (${ph.join(', ')})
     on conflict (id) do update set ${set.join(', ')}`,
    vals as never[],
  );
}

/** Device-only settings of this machine's copy, laid over preferences from elsewhere. */
function withDevicePrefsOf(incoming: unknown, here: unknown): unknown {
  const out = withoutDevicePrefs(incoming);
  if (!out || typeof out !== 'object' || !here || typeof here !== 'object') return out;
  const o = out as Record<string, unknown>;
  const h = here as Record<string, unknown>;
  for (const [group, keys] of Object.entries(DEVICE_PREFS) as [string, readonly string[]][]) {
    const mine = h[group];
    if (!mine || typeof mine !== 'object') continue;
    const kept = Object.fromEntries(keys.filter((k) => k in mine).map((k) => [k, (mine as Row)[k]]));
    if (!Object.keys(kept).length) continue;
    o[group] = { ...((o[group] as Row | undefined) ?? {}), ...kept };
  }
  return o;
}

/** The ids of one kind of place among keys like "notebook:<id>" and "thread:<id>". */
const placeIds = (places: readonly string[], kind: 'notebook' | 'thread') =>
  places.filter((p) => p.startsWith(`${kind}:`)).map((p) => p.slice(kind.length + 1));

/** A UI state value as it may leave this machine: device-only preferences taken out. */
function shareableUi(key: string, value: unknown): unknown {
  if (key !== 'prefs' || !value || typeof value !== 'object') return value;
  const v = value as { prefs?: unknown };
  return 'prefs' in v ? { ...v, prefs: withoutDevicePrefs(v.prefs) } : value;
}

export function sqlSyncSource(sql: Sql, owner: { userId: string; workspaceId: string }): ProSyncSource {
  const ws = { workspace_id: owner.workspaceId };

  /**
   * The notebooks and threads whose scope keeps everything here, as the
   * scopes say now (getEffectiveScope, the resolver every check uses). Only
   * places with a scope of their own, or a private notebook, can be.
   * `withdrawn` places (another device's) count as local too.
   */
  async function localSets(withdrawn: readonly string[] = []): Promise<Local> {
    const notebooks = new Set<string>(placeIds(withdrawn, 'notebook'));
    const threads = new Set<string>(placeIds(withdrawn, 'thread'));
    const nbs = await sql<{ id: string }[]>`
      select n.id from core.notebooks n
       where n.workspace_id = ${owner.workspaceId}
         and (n.private or exists (select 1 from core.scopes s where s.level = 'notebook' and s.ref_id = n.id))`;
    for (const { id } of nbs)
      if (!notebooks.has(id) && keepsLocal(await getEffectiveScope(sql, { notebookId: id })))
        notebooks.add(id);
    const ths = await sql<{ id: string }[]>`
      select t.id from core.threads t
        join core.scopes s on s.level = 'thread' and s.ref_id = t.id
       where t.workspace_id = ${owner.workspaceId}`;
    for (const { id } of ths)
      if (!threads.has(id) && keepsLocal(await getEffectiveScope(sql, { threadId: id }))) threads.add(id);
    // A thread can only narrow its notebook, so every thread in a local notebook is local.
    if (notebooks.size)
      for (const { id } of await sql<{ id: string }[]>`
        select id from core.threads
         where workspace_id = ${owner.workspaceId} and notebook_id = any(${[...notebooks]})`)
        threads.add(id);
    return { notebooks, threads };
  }

  /** Does this row (its own fields) sit in a place that keeps data here? */
  function isLocal(collection: string, id: string, d: Row | null | undefined, local: Local): boolean {
    const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
    switch (collection) {
      case 'notebooks':
        return local.notebooks.has(id);
      case 'threads': {
        const nb = str(d?.notebook_id);
        return local.threads.has(id) || (nb !== null && local.notebooks.has(nb));
      }
      case 'messages': {
        const th = str(d?.thread_id);
        return th !== null && local.threads.has(th);
      }
      case 'notes': {
        const nb = str(d?.notebook_id);
        return nb !== null && local.notebooks.has(nb);
      }
      case 'flows': {
        // A flow's scope is where it answers: a notebook's or a thread's flow lives there.
        const ref = str(d?.scope_ref);
        if (ref === null) return false;
        return d?.scope === 'notebook'
          ? local.notebooks.has(ref)
          : d?.scope === 'thread' && local.threads.has(ref);
      }
      default:
        return false;
    }
  }

  const pick = (name: Table, r: Row) =>
    Object.fromEntries(COLS[name].filter((c) => c in r).map((c) => [c, r[c]]));

  const markDeleted = async (name: Table, ids: string[]) => {
    if (!ids.length) return 0;
    const rows = await sql.unsafe<Row[]>(
      `update core.${name} set deleted_at = coalesce(deleted_at, now())${name === 'flows' ? ', active = false' : ''}
        where id = any($1::text[])${IN_WORKSPACE.has(name) ? ' and workspace_id = $2' : ''} returning id`,
      (IN_WORKSPACE.has(name) ? [ids, owner.workspaceId] : [ids]) as never[],
    );
    return rows.length;
  };

  const table = (
    name: Table,
    where: string,
    extra: Row = {},
    insertOnly: Row = {},
  ): Collection & { read(id: string): Promise<Row | null> } => ({
    async read(id) {
      const [r] = await sql.unsafe<Row[]>(
        `select * from core.${name} where id = $1${IN_WORKSPACE.has(name) ? ' and workspace_id = $2' : ''}`,
        (IN_WORKSPACE.has(name) ? [id, owner.workspaceId] : [id]) as never[],
      );
      return r ? pick(name, r) : null;
    },
    async changes(since, local) {
      const rows = await sql.unsafe<Row[]>(
        `select * from core.${name} where (${where})${IN_WORKSPACE.has(name) ? ' and workspace_id = $2' : ''} order by 1`,
        (IN_WORKSPACE.has(name)
          ? [since ?? '1970-01-01T00:00:00Z', owner.workspaceId]
          : [since ?? '1970-01-01T00:00:00Z']) as never[],
      );
      return rows.map((r): ProSyncChange => {
        const id = String(r.id);
        // A thread that moved (or left a deleted notebook) keeps its updated_at so the rail does not
        // reorder; placed_at says when it moved, and counts as the change time if it is later.
        const stamp = iso(r.updated_at ?? r.deleted_at ?? r.created_at);
        const placed = r.placed_at ? iso(r.placed_at) : '';
        const updatedAt = placed > stamp ? placed : stamp;
        return isLocal(name, id, r, local)
          ? { id, updatedAt, local: true }
          : { id, updatedAt, data: pick(name, r) };
      });
    },
    async apply(items) {
      let n = 0;
      for (const it of items) {
        if (it.deleted) continue;
        await upsert(sql, name, it.data, extra, insertOnly);
        n++;
      }
      return (
        n +
        (await markDeleted(
          name,
          items.filter((it) => it.deleted).map((it) => it.id),
        ))
      );
    },
  });

  const flows = table('flows', 'updated_at > $1 or deleted_at > $1', ws);
  const versionsOf = (id: string) =>
    sql.unsafe<Row[]>(
      'select version, name, graph, message, created_at from core.flow_versions where flow_id = $1 order by version',
      [id] as never[],
    );
  const messages = table(
    'messages',
    "(created_at > ($1::timestamptz - interval '1 day') or deleted_at > $1) and status in ('complete', 'error', 'stopped')",
    {},
    { trace_id: NO_TRACE },
  );

  const collections: Record<string, Collection> = {
    notebooks: table('notebooks', 'updated_at > $1 or deleted_at > $1', ws),
    flows: {
      // A flow travels with its versions: "the published one" must exist on arrival.
      async read(id) {
        const f = await flows.read(id);
        return f ? { ...f, versions: await versionsOf(id) } : null;
      },
      async changes(since, local) {
        const out = await flows.changes(since, local);
        for (const f of out) if (!f.local) (f.data as Row).versions = await versionsOf(f.id);
        return out;
      },
      async apply(items) {
        let n = 0;
        for (const it of items) {
          if (it.deleted) continue;
          const { versions, ...flow } = it.data as Row & { versions?: Row[] };
          await upsert(sql, 'flows', flow, ws);
          for (const v of versions ?? [])
            await sql.unsafe(
              `insert into core.flow_versions (flow_id, version, name, graph, message, created_at)
               values ($1, $2, $3, $4::text::jsonb, $5, $6) on conflict do nothing`,
              [it.id, v.version, v.name, JSON.stringify(v.graph), v.message ?? null, v.created_at] as never[],
            );
          n++;
        }
        return (
          n +
          (await markDeleted(
            'flows',
            items.filter((it) => it.deleted).map((it) => it.id),
          ))
        );
      },
    },
    threads: table('threads', 'updated_at > $1 or deleted_at > $1 or placed_at > $1', ws),
    // Messages have no updated_at: a day's look-back catches answers that
    // finished after they were created; unchanged ones are skipped by hash.
    messages: {
      ...messages,
      async apply(items) {
        // Parents before children: a reply never arrives before its question.
        const sorted = [...items].sort((a, b) =>
          iso(a.data.created_at).localeCompare(iso(b.data.created_at)),
        );
        return messages.apply(sorted);
      },
    },
    notes: table('notes', 'updated_at > $1 or deleted_at > $1'),
    preferences: {
      async read(key) {
        if (!SYNCED_UI_KEYS.includes(key)) return null;
        const [r] = await sql.unsafe<Row[]>(
          'select value from core.ui_state where user_id = $1 and key = $2',
          [owner.userId, key] as never[],
        );
        return r ? { value: shareableUi(key, r.value) } : null;
      },
      async changes(since) {
        const rows = await sql.unsafe<Row[]>(
          'select key, value, updated_at from core.ui_state where user_id = $1 and updated_at > $2 and key = any($3::text[])',
          [owner.userId, since ?? '1970-01-01T00:00:00Z', SYNCED_UI_KEYS] as never[],
        );
        return rows.map((r) => ({
          id: String(r.key),
          updatedAt: iso(r.updated_at),
          data: { value: shareableUi(String(r.key), r.value) },
        }));
      },
      async apply(items) {
        let n = 0;
        for (const it of items) {
          // An older computer may still send other keys (scroll positions): they stay where they were made.
          if (it.deleted || !SYNCED_UI_KEYS.includes(it.id)) continue;
          let value = (it.data as { value: unknown }).value;
          if (it.id === 'prefs' && value && typeof value === 'object' && 'prefs' in value) {
            const [here] = await sql.unsafe<{ value: { prefs?: unknown } | null }[]>(
              'select value from core.ui_state where user_id = $1 and key = $2',
              [owner.userId, it.id] as never[],
            );
            value = {
              ...value,
              prefs: withDevicePrefsOf((value as { prefs: unknown }).prefs, here?.value?.prefs),
            };
          }
          await sql.unsafe(
            `insert into core.ui_state (user_id, key, value, updated_at) values ($1, $2, $3::text::jsonb, now())
             on conflict (user_id, key) do update set value = excluded.value, updated_at = now()`,
            [owner.userId, it.id, JSON.stringify(value)] as never[],
          );
          n++;
        }
        return n;
      },
    },
  };

  /** The copies here of these items, for those that came without their place (a deletion). */
  async function rowsHere(collection: string, ids: string[]): Promise<Map<string, Row>> {
    if (!ids.length || !(collection in COLS)) return new Map();
    const name = collection as Table;
    const rows = await sql.unsafe<Row[]>(
      `select * from core.${name} where id = any($1::text[])${IN_WORKSPACE.has(name) ? ' and workspace_id = $2' : ''}`,
      (IN_WORKSPACE.has(name) ? [ids, owner.workspaceId] : [ids]) as never[],
    );
    return new Map(rows.map((r) => [String(r.id), r]));
  }

  return {
    // Applied in this order, so foreign keys always find their rows.
    collections: ['notebooks', 'flows', 'threads', 'messages', 'notes', 'preferences'],
    changes: async (c, since, withdrawn = []) => {
      const col = collections[c];
      if (!col) return [];
      return col.changes(
        since,
        c === 'preferences' ? { notebooks: new Set(), threads: new Set() } : await localSets(withdrawn),
      );
    },
    apply: (c, items) => collections[c]?.apply(items as never) ?? Promise.resolve(0),
    read: async (c, id) => (await collections[c]?.read?.(id)) ?? null,

    async localPlaces() {
      const { notebooks, threads } = await localSets();
      return [
        ...[...notebooks].map((id) => `notebook:${id}`),
        ...[...threads].map((id) => `thread:${id}`),
      ].sort();
    },

    async itemsIn(places) {
      const nb = placeIds(places, 'notebook');
      const own = placeIds(places, 'thread');
      if (!nb.length && !own.length) return [];
      const out: { collection: string; id: string }[] = [];
      const add = (collection: string, rows: { id: string }[]) => {
        for (const r of rows) out.push({ collection, id: r.id });
      };
      add(
        'notebooks',
        await sql<{ id: string }[]>`
          select id from core.notebooks where workspace_id = ${owner.workspaceId} and id = any(${nb})`,
      );
      const th = await sql<{ id: string }[]>`
        select id from core.threads
         where workspace_id = ${owner.workspaceId} and (id = any(${own}) or notebook_id = any(${nb}))`;
      add('threads', th);
      const thIds = th.map((t) => t.id);
      add(
        'messages',
        await sql<{ id: string }[]>`select id from core.messages where thread_id = any(${thIds})`,
      );
      add('notes', await sql<{ id: string }[]>`select id from core.notes where notebook_id = any(${nb})`);
      add(
        'flows',
        await sql<{ id: string }[]>`
          select id from core.flows
           where workspace_id = ${owner.workspaceId}
             and ((scope = 'notebook' and scope_ref = any(${nb})) or (scope = 'thread' and scope_ref = any(${thIds})))`,
      );
      return out;
    },

    async localOnly(c, items, withdrawn = []) {
      const out = new Set<string>();
      if (!items.length || c === 'preferences') return out;
      const local = await localSets(withdrawn);
      if (!local.notebooks.size && !local.threads.size) return out;
      const here = await rowsHere(
        c,
        items.map((it) => it.id),
      );
      for (const it of items)
        if (isLocal(c, it.id, it.data as Row | null, local) || isLocal(c, it.id, here.get(it.id), local))
          out.add(it.id);
      return out;
    },

    async remove(c, ids) {
      if (!ids.length || !(c in COLS)) return 0;
      const name = c as Table;
      const rows = await sql.unsafe<Row[]>(
        `update core.${name} set ${EMPTIED[name]}, deleted_at = coalesce(deleted_at, now())
          where id = any($1::text[])${IN_WORKSPACE.has(name) ? ' and workspace_id = $2' : ''} returning id`,
        (IN_WORKSPACE.has(name) ? [ids, owner.workspaceId] : [ids]) as never[],
      );
      const gone = rows.map((r) => String(r.id));
      if (name === 'flows' && gone.length)
        await sql`delete from core.flow_versions where flow_id = any(${gone})`;
      // A thread's summaries and half-written replies are its words too.
      if (name === 'threads' && gone.length) {
        await sql`delete from core.summaries where thread_id = any(${gone})`;
        await sql`delete from core.drafts where thread_id = any(${gone})`;
      }
      return rows.length;
    },
  };
}
