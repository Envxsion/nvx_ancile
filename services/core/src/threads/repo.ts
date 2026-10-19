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

import type { Message, Part, Thread, ThreadState, TrashItem, Usage } from '@nvx/contracts';
import { TRASH_DAYS } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { pgSafe } from '../db/json';
import { rollUp, type UsageArchiveRow } from '../usage/archive';
import { purgeThreads } from './purge-plan';

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
  /** Imported messages keep their own time, usage and provenance (Claude Code). */
  created_at?: string | null;
  usage?: Usage | null;
  provenance?: Record<string, unknown>;
}

export interface MessagePatch {
  parts?: Part[];
  status?: Message['status'];
  model_id?: string | null;
  usage?: Usage | null;
  provenance?: Record<string, unknown>;
  run_id?: string | null;
  /** CA4: the message exactly as it was sent to a model, as text. Internal: never on the wire. */
  sent?: string | null;
  /** CA2: the prompt epoch an answer was written in. Internal. */
  epoch_id?: string | null;
}

/** What a message was sent as, and the epoch it was written in (ThreadRepo.sentForms). */
export interface SentForm {
  sent: string | null;
  epoch_id: string | null;
}

export interface ThreadRecord extends Thread {
  workspace_id: string;
  title_source: 'auto' | 'user';
  root_message_id: string | null;
  archived_at: string | null;
  pinned_at: string | null;
  /** When the thread was last opened, for the rail's "unread" dot. */
  seen_at?: string | null;
}

/** A thread with what the rail needs beside it: leaves, and whether it is answering, waiting or unread. */
export type ThreadListRow = ThreadRecord & {
  leaves: number;
  live: boolean;
  waiting: boolean;
  unread: boolean;
};

/** The fields a bulk action sets, exactly (no clock of its own: Undo puts the old values back). */
export interface ThreadFields {
  notebook_id?: string | null;
  archived_at?: string | null;
  pinned_at?: string | null;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface ListThreads {
  limit?: number;
  /** Opaque: the last row's "updated_at|id" from the previous page. */
  cursor?: string | null;
  archived?: boolean;
  notebookId?: string;
}

/** A message's place in the tree, without its content (ThreadRepo.skeleton). */
export interface MessageNode {
  id: string;
  parent_id: string | null;
  role: Message['role'];
  created_at: string;
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
  listThreads(workspaceId: string, opts?: ListThreads): Promise<ThreadListRow[]>;
  /** Threads by id, deleted ones too (the Trash and Undo need them). Other workspaces' are left out. */
  statesOf(workspaceId: string, ids: string[]): Promise<ThreadState[]>;
  /** Set exactly these fields and nothing else, not even updated_at. False: no such thread. */
  setFields(workspaceId: string, id: string, fields: ThreadFields): Promise<boolean>;
  /** The Trash, newest deletion first. */
  listTrash(workspaceId: string): Promise<TrashItem[]>;
  /** Threads deleted before `cutoff`, oldest first (the daily purge). */
  trashedBefore(workspaceId: string, cutoff: Date): Promise<string[]>;
  /** Remove deleted threads and everything that hangs from them, for good. Returns the ids removed. */
  purge(ids: string[]): Promise<string[]>;
  /** The person has seen the thread's latest answer. */
  markSeen(id: string): Promise<void>;
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
  /**
   * The thread's shape without its content: every live message's id, parent,
   * role and time, in creation order. Cheap for a 20,000-message thread, so
   * paths and the tree are worked out before any parts are read.
   */
  skeleton(threadId: string): Promise<MessageNode[]>;
  /** These messages of the thread, whole, in the order asked (missing ids are skipped). */
  messagesByIds(threadId: string, ids: string[]): Promise<MessageRecord[]>;
  getMessage(id: string): Promise<MessageRecord | undefined>;
  /**
   * CA4: what these messages were sent as (text), and the epoch each answer was
   * written in. Messages with neither are left out; they are rebuilt from their parts.
   */
  sentForms(ids: string[]): Promise<Map<string, SentForm>>;
  insertMessage(m: NewMessage): Promise<MessageRecord>;
  /** Many messages in one statement, parents before children (an import). */
  insertMessages(ms: NewMessage[]): Promise<void>;
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
  seen_at?: Date | null;
  deleted_at?: Date | null;
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
  seen_at: iso(r.seen_at ?? null),
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

const stateFromRow = (r: ThreadRow): ThreadState => ({
  id: r.id,
  title: r.title,
  notebook_id: r.notebook_id,
  archived_at: iso(r.archived_at),
  pinned_at: iso(r.pinned_at),
  updated_at: r.updated_at.toISOString(),
  deleted_at: iso(r.deleted_at ?? null),
});

/** When the daily purge removes a thread that was deleted at `deletedAt`. */
export const purgeAt = (deletedAt: string): string =>
  new Date(Date.parse(deletedAt) + TRASH_DAYS * 86_400_000).toISOString();

const trashFromRow = (r: ThreadRow): TrashItem => {
  const deleted_at = (r.deleted_at as Date).toISOString();
  return { id: r.id, title: r.title, notebook_id: r.notebook_id, deleted_at, purge_at: purgeAt(deleted_at) };
};

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
    // The cursor carries milliseconds (toISOString) and Postgres keeps
    // microseconds, so paging and its order both work to the millisecond.
    const rows = await sql<
      (ThreadRow & { leaves: number; live: boolean; waiting: boolean; unread: boolean })[]
    >`
      select t.*,
        (select count(*)::int from core.messages m where m.thread_id = t.id and m.deleted_at is null
           and not exists (select 1 from core.messages c where c.parent_id = m.id and c.deleted_at is null)) as leaves,
        exists (select 1 from core.runs r where r.thread_id = t.id
           and r.status in ('queued','running','waiting_approval','waiting_compute')) as live,
        exists (select 1 from core.runs r where r.thread_id = t.id and r.status = 'waiting_approval') as waiting,
        exists (select 1 from core.messages m where m.thread_id = t.id and m.deleted_at is null
           and m.role = 'assistant' and m.status = 'complete'
           and m.created_at > coalesce(t.seen_at, t.created_at)) as unread
      from core.threads t
      where t.workspace_id = ${workspaceId} and t.deleted_at is null
        and ${opts.archived ? sql`t.archived_at is not null` : sql`t.archived_at is null`}
        ${opts.notebookId ? sql`and t.notebook_id = ${opts.notebookId}` : sql``}
        ${after ? sql`and (date_trunc('milliseconds', t.updated_at), t.id) < (${after.at}::timestamptz, ${after.id})` : sql``}
      order by date_trunc('milliseconds', t.updated_at) desc, t.id desc limit ${limit}`;
    return rows.map((r) => ({
      ...threadFromRow(r),
      leaves: r.leaves,
      live: r.live,
      waiting: r.waiting,
      unread: r.unread,
    }));
  }

  async statesOf(workspaceId: string, ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await this.sql<ThreadRow[]>`
      select * from core.threads where workspace_id = ${workspaceId} and id = any(${ids})`;
    return rows.map(stateFromRow);
  }

  async setFields(workspaceId: string, id: string, f: ThreadFields) {
    const has = (k: keyof ThreadFields) => f[k] !== undefined;
    const rows = await this.sql`
      update core.threads set
        notebook_id = case when ${has('notebook_id')} then ${f.notebook_id ?? null} else notebook_id end,
        archived_at = case when ${has('archived_at')} then ${f.archived_at ?? null}::timestamptz else archived_at end,
        pinned_at = case when ${has('pinned_at')} then ${f.pinned_at ?? null}::timestamptz else pinned_at end,
        updated_at = case when ${has('updated_at')} then ${f.updated_at ?? null}::timestamptz else updated_at end,
        deleted_at = case when ${has('deleted_at')} then ${f.deleted_at ?? null}::timestamptz else deleted_at end
      where id = ${id} and workspace_id = ${workspaceId}
      returning id`;
    return rows.length > 0;
  }

  async listTrash(workspaceId: string) {
    const rows = await this.sql<ThreadRow[]>`
      select * from core.threads where workspace_id = ${workspaceId} and deleted_at is not null
      order by deleted_at desc, id desc`;
    return rows.map(trashFromRow);
  }

  async trashedBefore(workspaceId: string, cutoff: Date) {
    const rows = await this.sql<{ id: string }[]>`
      select id from core.threads
      where workspace_id = ${workspaceId} and deleted_at is not null
        and deleted_at < ${cutoff.toISOString()}::timestamptz
      order by deleted_at, id`;
    return rows.map((r) => r.id);
  }

  async purge(ids: string[]) {
    if (ids.length === 0) return [];
    return this.sql.begin(async (tx) => {
      // Deleted threads only, and never one a run is still answering in (bulk.ts checks too; this
      // holds even if a run starts between that check and this transaction).
      const gone = await tx<{ id: string }[]>`
        select t.id from core.threads t
        where t.id = any(${ids}) and t.deleted_at is not null
          and not exists (
            select 1 from core.runs r where r.thread_id = t.id
              and r.status in ('queued','running','waiting_approval','waiting_compute'))
        for update of t`;
      const list = gone.map((r) => r.id);
      // What happens to each table is PURGE_PLAN's, reviewed there; usage is rolled up first.
      await purgeThreads(tx as unknown as Sql, list);
      return list;
    });
  }

  async markSeen(id: string) {
    await this.sql`update core.threads set seen_at = now() where id = ${id}`;
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

  async skeleton(threadId: string) {
    const rows = await this.sql<
      { id: string; parent_id: string | null; role: Message['role']; created_at: Date }[]
    >`
      select id, parent_id, role, created_at from core.messages
      where thread_id = ${threadId} and deleted_at is null order by created_at, id`;
    return rows.map((r) => ({
      id: r.id,
      parent_id: r.parent_id,
      role: r.role,
      created_at: r.created_at.toISOString(),
    }));
  }

  async messagesByIds(threadId: string, ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await this.sql<MessageRow[]>`
      select * from core.messages where thread_id = ${threadId} and id = any(${ids}) and deleted_at is null`;
    const byId = new Map(rows.map((r) => [r.id, messageFromRow(r)] as const));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  async getMessage(id: string) {
    const rows = await this.sql<MessageRow[]>`select * from core.messages where id = ${id}`;
    return rows[0] ? messageFromRow(rows[0]) : undefined;
  }

  async sentForms(ids: string[]) {
    const out = new Map<string, SentForm>();
    if (!ids.length) return out;
    const rows = await this.sql<{ id: string; sent: string | null; epoch_id: string | null }[]>`
      select id, sent, epoch_id from core.messages
      where id = any(${ids}) and (sent is not null or epoch_id is not null)`;
    for (const r of rows) out.set(r.id, { sent: r.sent, epoch_id: r.epoch_id });
    return out;
  }

  async insertMessage(m: NewMessage) {
    const rows = await this.sql<MessageRow[]>`
      insert into core.messages (id, thread_id, parent_id, role, parts, model_id, requested_model_id, status, edit_of_id, run_id, trace_id)
      values (${m.id}, ${m.thread_id}, ${m.parent_id}, ${m.role}, ${this.sql.json(pgSafe(m.parts) as never)}, ${m.model_id ?? null},
        ${m.requested_model_id ?? null}, ${m.status}, ${m.edit_of_id ?? null}, ${m.run_id ?? null}, ${m.trace_id})
      returning *`;
    return messageFromRow(rows[0] as MessageRow);
  }

  async insertMessages(ms: NewMessage[]) {
    if (!ms.length) return;
    const rows = ms.map((m) => ({
      id: m.id,
      thread_id: m.thread_id,
      parent_id: m.parent_id,
      role: m.role,
      parts: pgSafe(m.parts),
      model_id: m.model_id ?? null,
      requested_model_id: m.requested_model_id ?? null,
      status: m.status,
      edit_of_id: m.edit_of_id ?? null,
      provenance: pgSafe(m.provenance ?? {}),
      usage: m.usage ? pgSafe(m.usage) : null,
      run_id: m.run_id ?? null,
      trace_id: m.trace_id,
      created_at: m.created_at ?? new Date().toISOString(),
    }));
    // One statement: the parent foreign key is checked when it ends, so
    // children may sit beside their parents in the same batch.
    await this.sql`
      insert into core.messages (id, thread_id, parent_id, role, parts, model_id, requested_model_id, status,
        edit_of_id, provenance, usage, run_id, trace_id, created_at)
      select x.id, x.thread_id, x.parent_id, x.role, x.parts, x.model_id, x.requested_model_id, x.status,
        x.edit_of_id, x.provenance, x.usage, x.run_id, x.trace_id, x.created_at
      from jsonb_to_recordset(${this.sql.json(rows as never)}) as x(id text, thread_id text,
        parent_id text, role text, parts jsonb, model_id text, requested_model_id text, status text,
        edit_of_id text, provenance jsonb, usage jsonb, run_id text, trace_id text, created_at timestamptz)`;
  }

  async updateMessage(id: string, p: MessagePatch) {
    await this.sql`
      update core.messages set
        parts = case when ${p.parts === undefined} then parts else ${this.sql.json(pgSafe(p.parts ?? []) as never)} end,
        status = coalesce(${p.status ?? null}, status),
        model_id = case when ${p.model_id === undefined} then model_id else ${p.model_id ?? null} end,
        usage = case when ${p.usage === undefined} then usage else ${p.usage ? this.sql.json(pgSafe(p.usage) as never) : null} end,
        provenance = case when ${p.provenance === undefined} then provenance else provenance || ${this.sql.json(pgSafe(p.provenance ?? {}) as never)} end,
        run_id = case when ${p.run_id === undefined} then run_id else ${p.run_id ?? null} end,
        sent = case when ${p.sent === undefined} then sent else ${p.sent ?? null} end,
        epoch_id = case when ${p.epoch_id === undefined} then epoch_id else ${p.epoch_id ?? null} end
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
  /** Sent forms and epochs, kept beside the records so they never reach a route's output. */
  readonly sentById = new Map<string, SentForm>();
  private tick = 0;
  /** Runs that are live, for listThreads(); tests set this. */
  liveThreads = new Set<string>();
  /** Threads whose run waits on an approval; tests set this. */
  waitingThreads = new Set<string>();
  /** Spend of purged threads, rolled up as core.usage_archive holds it (usage/archive.ts). */
  readonly usageArchive: UsageArchiveRow[] = [];
  /** A run's kind, for the roll-up's engine; tests that care set this. */
  runKind: (runId: string) => string | null = () => null;

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
      seen_at: at,
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
        const seen = t.seen_at ?? t.created_at;
        return {
          ...rest,
          leaves,
          live: this.liveThreads.has(t.id),
          waiting: this.waitingThreads.has(t.id),
          unread: mine.some(
            (m) => m.role === 'assistant' && m.status === 'complete' && !m.deleted_at && m.created_at > seen,
          ),
        };
      });
  }

  async statesOf(workspaceId: string, ids: string[]) {
    return ids.flatMap((id) => {
      const t = this.threads.get(id);
      return t && t.workspace_id === workspaceId
        ? [
            {
              id: t.id,
              title: t.title,
              notebook_id: t.notebook_id,
              archived_at: t.archived_at,
              pinned_at: t.pinned_at,
              updated_at: t.updated_at,
              deleted_at: t.deleted_at ?? null,
            },
          ]
        : [];
    });
  }

  async setFields(workspaceId: string, id: string, f: ThreadFields) {
    const t = this.threads.get(id);
    if (!t || t.workspace_id !== workspaceId) return false;
    if (f.notebook_id !== undefined) t.notebook_id = f.notebook_id;
    if (f.archived_at !== undefined) t.archived_at = f.archived_at;
    if (f.pinned_at !== undefined) t.pinned_at = f.pinned_at;
    if (f.updated_at !== undefined) t.updated_at = f.updated_at;
    if (f.deleted_at !== undefined) t.deleted_at = f.deleted_at;
    return true;
  }

  async listTrash(workspaceId: string) {
    return [...this.threads.values()]
      .filter((t) => t.workspace_id === workspaceId && t.deleted_at)
      .sort((a, b) => (b.deleted_at ?? '').localeCompare(a.deleted_at ?? '') || b.id.localeCompare(a.id))
      .map((t) => {
        const deleted_at = t.deleted_at as string;
        return {
          id: t.id,
          title: t.title,
          notebook_id: t.notebook_id,
          deleted_at,
          purge_at: purgeAt(deleted_at),
        };
      });
  }

  async trashedBefore(workspaceId: string, cutoff: Date) {
    const at = cutoff.toISOString();
    return [...this.threads.values()]
      .filter((t) => t.workspace_id === workspaceId && t.deleted_at && t.deleted_at < at)
      .sort((a, b) => (a.deleted_at ?? '').localeCompare(b.deleted_at ?? ''))
      .map((t) => t.id);
  }

  async purge(ids: string[]) {
    const gone: string[] = [];
    for (const id of ids) {
      const t = this.threads.get(id);
      if (!t?.deleted_at || this.liveThreads.has(id) || this.waitingThreads.has(id)) continue;
      const own = [...this.msgs.values()].filter((m) => m.thread_id === id);
      this.usageArchive.push(
        ...rollUp(own, {
          workspaceOf: (tid) => this.threads.get(tid)?.workspace_id ?? null,
          runKind: this.runKind,
        }),
      );
      for (const m of own) this.msgs.delete(m.id);
      this.threads.delete(id);
      gone.push(id);
    }
    return gone;
  }

  async markSeen(id: string) {
    const t = this.threads.get(id);
    if (t) t.seen_at = this.stamp();
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

  async skeleton(threadId: string) {
    return [...this.msgs.values()]
      .filter((m) => m.thread_id === threadId && !m.deleted_at)
      .map((m) => ({ id: m.id, parent_id: m.parent_id, role: m.role, created_at: m.created_at }));
  }

  async messagesByIds(threadId: string, ids: string[]) {
    return ids.flatMap((id) => {
      const m = this.msgs.get(id);
      return m && m.thread_id === threadId && !m.deleted_at ? [structuredClone(m)] : [];
    });
  }

  async getMessage(id: string) {
    const m = this.msgs.get(id);
    return m ? structuredClone(m) : undefined;
  }

  async sentForms(ids: string[]) {
    const out = new Map<string, SentForm>();
    for (const id of ids) {
      const f = this.sentById.get(id);
      if (f && (f.sent !== null || f.epoch_id !== null)) out.set(id, { ...f });
    }
    return out;
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
      provenance: structuredClone(m.provenance ?? {}),
      usage: m.usage ?? null,
      run_id: m.run_id ?? null,
      trace_id: m.trace_id,
      created_at: m.created_at ? new Date(m.created_at).toISOString() : this.stamp(),
      deleted_at: null,
    };
    this.msgs.set(m.id, rec);
    return structuredClone(rec);
  }

  async insertMessages(ms: NewMessage[]) {
    for (const m of ms) {
      if (m.parent_id && !this.msgs.has(m.parent_id)) throw new Error(`parent ${m.parent_id} does not exist`);
      await this.insertMessage(m);
    }
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
    if (p.sent !== undefined || p.epoch_id !== undefined) {
      const f = this.sentById.get(id) ?? { sent: null, epoch_id: null };
      this.sentById.set(id, {
        sent: p.sent === undefined ? f.sent : p.sent,
        epoch_id: p.epoch_id === undefined ? f.epoch_id : p.epoch_id,
      });
    }
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
