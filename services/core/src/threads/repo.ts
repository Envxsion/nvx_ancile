/**
 * ------------------------------------------------------------------
 *  Title    |  Threads and messages
 *  Ref      |  DESIGN.md §8
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Storage for the message tree. Messages are never
 *           |  copied: a branch is a different head over shared rows,
 *           |  so every read is "load the thread's messages, walk the
 *           |  path" (threads/path.ts does the walking).
 *  How      |  ThreadRepo is the interface the routes and the conductor
 *           |  use; PgThreadRepo is the real one and MemoryThreadRepo
 *           |  backs unit tests. Rows map to the wire shape in
 *           |  @nvx/contracts here and nowhere else.
 * ------------------------------------------------------------------
 */

import type { Message, Part, Thread, Usage } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { pgSafe } from '../db/json';

export type MessageRecord = Omit<Message, 'siblings'> & { deleted_at?: string | null };

export interface NewMessage {
  id: string;
  thread_id: string;
  parent_id: string | null;
  role: Message['role'];
  parts: Part[];
  status: Message['status'];
  model_id?: string | null;
  requested_model_id?: string | null;
  edit_of_id?: string | null;
  run_id?: string | null;
  trace_id: string;
}

export interface MessagePatch {
  parts?: Part[];
  status?: Message['status'];
  model_id?: string | null;
  usage?: Usage | null;
  provenance?: Record<string, unknown>;
  run_id?: string | null;
}

export interface ThreadRecord extends Thread {
  workspace_id: string;
  title_source: 'auto' | 'user';
  root_message_id: string | null;
  archived_at: string | null;
  pinned_at: string | null;
}

export interface ListThreads {
  limit?: number;
  /** Opaque: the last row's "updated_at|id" from the previous page. */
  cursor?: string | null;
  archived?: boolean;
  notebookId?: string;
}

export interface SearchHit {
  thread_id: string;
  message_id: string;
  title: string;
  text: string;
  updated_at: string;
}

export interface ThreadRepo {
  createThread(t: {
    id: string;
    workspace_id: string;
    title?: string;
    notebook_id?: string | null;
    settings?: Thread['settings'];
  }): Promise<ThreadRecord>;
  /** A thread that is not deleted (archived threads still open). */
  getThread(id: string): Promise<ThreadRecord | undefined>;
  listThreads(
    workspaceId: string,
    opts?: ListThreads,
  ): Promise<(ThreadRecord & { leaves: number; live: boolean })[]>;
  patchThread(
    id: string,
    patch: {
      title?: string;
      title_source?: 'auto' | 'user';
      settings?: Thread['settings'];
      active_head_id?: string;
      root_message_id?: string;
      pinned?: boolean;
      archived?: boolean;
      notebook_id?: string | null;
    },
  ): Promise<ThreadRecord | undefined>;
  deleteThread(id: string): Promise<boolean>;
  /** Messages whose text contains `q`, newest thread first, one hit per thread. */
  searchMessages(workspaceId: string, q: string, limit: number): Promise<SearchHit[]>;
  /** Threads per notebook, for notebook counts. */
  countByNotebook(workspaceId: string): Promise<Map<string, number>>;
  messages(threadId: string): Promise<MessageRecord[]>;
  getMessage(id: string): Promise<MessageRecord | undefined>;
  insertMessage(m: NewMessage): Promise<MessageRecord>;
  updateMessage(id: string, patch: MessagePatch): Promise<void>;
  /** Soft-delete messages a turn wrote before it was refused (a second send that lost the race). */
  discardMessages(ids: string[]): Promise<void>;
  /** Bring back messages a subtree delete removed (Undo). */
  restoreMessages(ids: string[]): Promise<void>;
}

/* ---- Postgres ------------------------------------------------------------- */

interface ThreadRow {
  id: string;
  workspace_id: string;
  notebook_id: string | null;
  title: string;
  title_source: 'auto' | 'user';
  root_message_id: string | null;
  active_head_id: string | null;
  settings: Thread['settings'];
  archived_at: Date | null;
  pinned_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  thread_id: string;
  parent_id: string | null;
  role: Message['role'];
  parts: Part[];
  model_id: string | null;
  requested_model_id: string | null;
  status: Message['status'];
  edit_of_id: string | null;
  provenance: Record<string, unknown>;
  usage: Usage | null;
  run_id: string | null;
  trace_id: string;
  created_at: Date;
  deleted_at: Date | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const threadFromRow = (r: ThreadRow): ThreadRecord => ({
  id: r.id,
  workspace_id: r.workspace_id,
  notebook_id: r.notebook_id,
  title: r.title,
  title_source: r.title_source,
  root_message_id: r.root_message_id,
  active_head_id: r.active_head_id,
  settings: r.settings ?? {},
  archived_at: iso(r.archived_at),
  pinned_at: iso(r.pinned_at),
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at.toISOString(),
});

/** "updated_at|id" of a row, the keyset for the next page. */
export const cursorOf = (t: { updated_at: string; id: string }) => `${t.updated_at}|${t.id}`;
function parseCursor(c: string | null | undefined): { at: string; id: string } | null {
  if (!c) return null;
  const i = c.lastIndexOf('|');
  if (i < 0 || Number.isNaN(Date.parse(c.slice(0, i)))) return null;
  return { at: c.slice(0, i), id: c.slice(i + 1) };
}

/** The text around the first match, with the match wrapped in «…». */
export function snippetOf(text: string, q: string, radius = 70): string | null {
  const flat = text.replace(/\s+/g, ' ');
  const i = flat.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - radius);
  const end = Math.min(flat.length, i + q.length + radius);
  return `${start > 0 ? '…' : ''}${flat.slice(start, i)}«${flat.slice(i, i + q.length)}»${flat.slice(i + q.length, end)}${end < flat.length ? '…' : ''}`;
}

const messageFromRow = (r: MessageRow): MessageRecord => ({
  id: r.id,
  thread_id: r.thread_id,
  parent_id: r.parent_id,
  role: r.role,
  parts: r.parts,
  model_id: r.model_id,
  requested_model_id: r.requested_model_id,
  status: r.status,
  edit_of_id: r.edit_of_id,
  provenance: r.provenance ?? {},
  usage: r.usage,
  run_id: r.run_id,
  trace_id: r.trace_id,
  created_at: r.created_at.toISOString(),
  deleted_at: iso(r.deleted_at),
});

export class PgThreadRepo implements ThreadRepo {
  constructor(private readonly sql: Sql) {}

  async createThread(t: Parameters<ThreadRepo['createThread']>[0]): Promise<ThreadRecord> {
    const rows = await this.sql<ThreadRow[]>`
      insert into core.threads (id, workspace_id, notebook_id, title, title_source, settings)
      values (${t.id}, ${t.workspace_id}, ${t.notebook_id ?? null}, ${t.title ?? 'New thread'}, ${t.title ? 'user' : 'auto'},
        ${this.sql.json((t.settings ?? {}) as never)})
      returning *`;
    return threadFromRow(rows[0] as ThreadRow);
  }

  async getThread(id: string) {
    const rows = await this.sql<
      ThreadRow[]
    >`select * from core.threads where id = ${id} and deleted_at is null`;
    return rows[0] ? threadFromRow(rows[0]) : undefined;
  }

  async listThreads(workspaceId: string, opts: ListThreads = {}) {
    const limit = opts.limit ?? 200;
    const after = parseCursor(opts.cursor);
    const sql = this.sql;
    const rows = await sql<(ThreadRow & { leaves: number; live: boolean })[]>`
      select t.*,
        (select count(*)::int from core.messages m where m.thread_id = t.id and m.deleted_at is null
           and not exists (select 1 from core.messages c where c.parent_id = m.id and c.deleted_at is null)) as leaves,
        exists (select 1 from core.runs r where r.thread_id = t.id
           and r.status in ('queued','running','waiting_approval','waiting_compute')) as live
      from core.threads t
      where t.workspace_id = ${workspaceId} and t.deleted_at is null
        and ${opts.archived ? sql`t.archived_at is not null` : sql`t.archived_at is null`}
        ${opts.notebookId ? sql`and t.notebook_id = ${opts.notebookId}` : sql``}
        ${after ? sql`and (t.updated_at, t.id) < (${after.at}::timestamptz, ${after.id})` : sql``}
      order by t.updated_at desc, t.id desc limit ${limit}`;
    return rows.map((r) => ({ ...threadFromRow(r), leaves: r.leaves, live: r.live }));
  }

  async searchMessages(workspaceId: string, q: string, limit: number) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = await this.sql<
      { thread_id: string; message_id: string; title: string; parts: Part[]; updated_at: Date }[]
    >`
      select distinct on (t.id) t.id as thread_id, m.id as message_id, t.title, m.parts, t.updated_at
      from core.messages m join core.threads t on t.id = m.thread_id
      where t.workspace_id = ${workspaceId} and t.deleted_at is null and m.deleted_at is null
        and m.role in ('user','assistant') and m.parts::text ilike ${like}
      order by t.id, m.created_at desc
      limit ${limit * 4}`;
    return rows
      .map((r) => ({
        thread_id: r.thread_id,
        message_id: r.message_id,
        title: r.title,
        text: textOf(r.parts),
        updated_at: r.updated_at.toISOString(),
      }))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit);
  }

  async countByNotebook(workspaceId: string) {
    const rows = await this.sql<{ notebook_id: string; n: number }[]>`
      select notebook_id, count(*)::int as n from core.threads
      where workspace_id = ${workspaceId} and deleted_at is null and notebook_id is not null
      group by notebook_id`;
    return new Map(rows.map((r) => [r.notebook_id, r.n] as const));
  }

  async patchThread(id: string, p: Parameters<ThreadRepo['patchThread']>[1]) {
    const rows = await this.sql<ThreadRow[]>`
      update core.threads set
        title = coalesce(${p.title ?? null}, title),
        title_source = coalesce(${p.title_source ?? null}, title_source),
        settings = case when ${p.settings === undefined} then settings else settings || ${this.sql.json((p.settings ?? {}) as never)} end,
        active_head_id = coalesce(${p.active_head_id ?? null}, active_head_id),
        root_message_id = coalesce(root_message_id, ${p.root_message_id ?? null}),
        pinned_at = case when ${p.pinned === undefined} then pinned_at
          when ${p.pinned === true} then coalesce(pinned_at, now()) else null end,
        archived_at = case when ${p.archived === undefined} then archived_at
          when ${p.archived === true} then coalesce(archived_at, now()) else null end,
        notebook_id = case when ${p.notebook_id === undefined} then notebook_id else ${p.notebook_id ?? null} end,
        updated_at = now()
      where id = ${id} and deleted_at is null
      returning *`;
    return rows[0] ? threadFromRow(rows[0]) : undefined;
  }

  async deleteThread(id: string) {
    const rows = await this
      .sql`update core.threads set deleted_at = now() where id = ${id} and deleted_at is null returning id`;
    return rows.length > 0;
  }

  async messages(threadId: string) {
    const rows = await this.sql<MessageRow[]>`
      select * from core.messages where thread_id = ${threadId} and deleted_at is null order by created_at, id`;
    return rows.map(messageFromRow);
  }

  async getMessage(id: string) {
    const rows = await this.sql<MessageRow[]>`select * from core.messages where id = ${id}`;
    return rows[0] ? messageFromRow(rows[0]) : undefined;
  }

  async insertMessage(m: NewMessage) {
    const rows = await this.sql<MessageRow[]>`
      insert into core.messages (id, thread_id, parent_id, role, parts, model_id, requested_model_id, status, edit_of_id, run_id, trace_id)
      values (${m.id}, ${m.thread_id}, ${m.parent_id}, ${m.role}, ${this.sql.json(pgSafe(m.parts) as never)}, ${m.model_id ?? null},
        ${m.requested_model_id ?? null}, ${m.status}, ${m.edit_of_id ?? null}, ${m.run_id ?? null}, ${m.trace_id})
      returning *`;
    return messageFromRow(rows[0] as MessageRow);
  }

  async updateMessage(id: string, p: MessagePatch) {
    await this.sql`
      update core.messages set
        parts = case when ${p.parts === undefined} then parts else ${this.sql.json(pgSafe(p.parts ?? []) as never)} end,
        status = coalesce(${p.status ?? null}, status),
        model_id = case when ${p.model_id === undefined} then model_id else ${p.model_id ?? null} end,
        usage = case when ${p.usage === undefined} then usage else ${p.usage ? this.sql.json(pgSafe(p.usage) as never) : null} end,
        provenance = case when ${p.provenance === undefined} then provenance else provenance || ${this.sql.json(pgSafe(p.provenance ?? {}) as never)} end,
        run_id = case when ${p.run_id === undefined} then run_id else ${p.run_id ?? null} end
      where id = ${id}`;
  }

  async discardMessages(ids: string[]) {
    if (!ids.length) return;
    await this
      .sql`update core.messages set deleted_at = now() where id in ${this.sql(ids)} and deleted_at is null`;
  }

  async restoreMessages(ids: string[]) {
    if (!ids.length) return;
    await this.sql`update core.messages set deleted_at = null where id in ${this.sql(ids)}`;
  }
}

/* ---- Memory (unit tests) -------------------------------------------------- */

export class MemoryThreadRepo implements ThreadRepo {
  readonly threads = new Map<string, ThreadRecord & { deleted_at?: string | null }>();
  readonly msgs = new Map<string, MessageRecord>();
  private tick = 0;
  /** Runs that are live, for listThreads(); tests set this. */
  liveThreads = new Set<string>();

  private stamp() {
    return new Date(Date.UTC(2026, 9, 7, 12, 0, 0, this.tick++)).toISOString();
  }

  async createThread(t: Parameters<ThreadRepo['createThread']>[0]) {
    const at = this.stamp();
    const rec: ThreadRecord = {
      id: t.id,
      workspace_id: t.workspace_id,
      notebook_id: t.notebook_id ?? null,
      title: t.title ?? 'New thread',
      title_source: t.title ? 'user' : 'auto',
      root_message_id: null,
      active_head_id: null,
      settings: t.settings ?? {},
      archived_at: null,
      pinned_at: null,
      created_at: at,
      updated_at: at,
    };
    this.threads.set(t.id, rec);
    return { ...rec };
  }

  async getThread(id: string) {
    const t = this.threads.get(id);
    if (!t || t.deleted_at) return undefined;
    const { deleted_at: _d, ...rest } = t;
    return { ...rest };
  }

  async listThreads(workspaceId: string, opts: ListThreads = {}) {
    const all = [...this.msgs.values()];
    const after = parseCursor(opts.cursor);
    return [...this.threads.values()]
      .filter(
        (t) =>
          t.workspace_id === workspaceId &&
          !t.deleted_at &&
          Boolean(t.archived_at) === Boolean(opts.archived) &&
          (!opts.notebookId || t.notebook_id === opts.notebookId),
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id))
      .filter((t) => !after || t.updated_at < after.at || (t.updated_at === after.at && t.id < after.id))
      .slice(0, opts.limit ?? 200)
      .map((t) => {
        const { deleted_at: _d, ...rest } = t;
        const mine = all.filter((m) => m.thread_id === t.id);
        const leaves = mine.filter((m) => !mine.some((c) => c.parent_id === m.id)).length;
        return { ...rest, leaves, live: this.liveThreads.has(t.id) };
      });
  }

  async searchMessages(workspaceId: string, q: string, limit: number) {
    const low = q.toLowerCase();
    const hits = new Map<string, SearchHit>();
    for (const m of [...this.msgs.values()].reverse()) {
      const t = this.threads.get(m.thread_id);
      if (!t || t.deleted_at || t.workspace_id !== workspaceId || m.deleted_at || hits.has(t.id)) continue;
      const text = textOf(m.parts);
      if (text.toLowerCase().includes(low))
        hits.set(t.id, { thread_id: t.id, message_id: m.id, title: t.title, text, updated_at: t.updated_at });
    }
    return [...hits.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit);
  }

  async countByNotebook(workspaceId: string) {
    const out = new Map<string, number>();
    for (const t of this.threads.values())
      if (t.workspace_id === workspaceId && !t.deleted_at && t.notebook_id)
        out.set(t.notebook_id, (out.get(t.notebook_id) ?? 0) + 1);
    return out;
  }

  async patchThread(id: string, p: Parameters<ThreadRepo['patchThread']>[1]) {
    const t = this.threads.get(id);
    if (!t || t.deleted_at) return undefined;
    if (p.pinned !== undefined) t.pinned_at = p.pinned ? (t.pinned_at ?? this.stamp()) : null;
    if (p.archived !== undefined) t.archived_at = p.archived ? (t.archived_at ?? this.stamp()) : null;
    if (p.notebook_id !== undefined) t.notebook_id = p.notebook_id;
    if (p.title !== undefined) t.title = p.title;
    if (p.title_source !== undefined) t.title_source = p.title_source;
    if (p.settings !== undefined) t.settings = { ...t.settings, ...p.settings };
    if (p.active_head_id !== undefined) t.active_head_id = p.active_head_id;
    if (p.root_message_id !== undefined && !t.root_message_id) t.root_message_id = p.root_message_id;
    t.updated_at = this.stamp();
    const { deleted_at: _d, ...rest } = t;
    return { ...rest };
  }

  async deleteThread(id: string) {
    const t = this.threads.get(id);
    if (!t || t.deleted_at) return false;
    t.deleted_at = this.stamp();
    return true;
  }

  async messages(threadId: string) {
    return [...this.msgs.values()]
      .filter((m) => m.thread_id === threadId && !m.deleted_at)
      .map((m) => structuredClone(m));
  }

  async getMessage(id: string) {
    const m = this.msgs.get(id);
    return m ? structuredClone(m) : undefined;
  }

  async insertMessage(m: NewMessage) {
    const rec: MessageRecord = {
      id: m.id,
      thread_id: m.thread_id,
      parent_id: m.parent_id,
      role: m.role,
      parts: structuredClone(m.parts),
      model_id: m.model_id ?? null,
      requested_model_id: m.requested_model_id ?? null,
      status: m.status,
      edit_of_id: m.edit_of_id ?? null,
      provenance: {},
      usage: null,
      run_id: m.run_id ?? null,
      trace_id: m.trace_id,
      created_at: this.stamp(),
      deleted_at: null,
    };
    this.msgs.set(m.id, rec);
    return structuredClone(rec);
  }

  async updateMessage(id: string, p: MessagePatch) {
    const m = this.msgs.get(id);
    if (!m) return;
    if (p.parts !== undefined) m.parts = structuredClone(p.parts);
    if (p.status !== undefined) m.status = p.status;
    if (p.model_id !== undefined) m.model_id = p.model_id;
    if (p.usage !== undefined) m.usage = p.usage;
    if (p.provenance !== undefined) m.provenance = { ...m.provenance, ...p.provenance };
    if (p.run_id !== undefined) m.run_id = p.run_id;
  }

  async discardMessages(ids: string[]) {
    for (const id of ids) {
      const m = this.msgs.get(id);
      if (m && !m.deleted_at) m.deleted_at = this.stamp();
    }
  }

  async restoreMessages(ids: string[]) {
    for (const id of ids) {
      const m = this.msgs.get(id);
      if (m) m.deleted_at = null;
    }
  }
}

/** Messages as path.ts tree nodes (it walks `parentId`). */
export type TreeRecord = MessageRecord & { parentId: string | null };
export function asTree(msgs: MessageRecord[]): TreeRecord[] {
  return msgs.map((m) => ({ ...m, parentId: m.parent_id }));
}

/** Plain text of a message's parts, for titles, previews and history. */
export function textOf(parts: Part[]): string {
  return parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
}
