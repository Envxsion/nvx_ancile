/**
 * ------------------------------------------------------------------
 *  Title    |  Chat import storage
 *  Ref      |  ROADMAP SU1 · migration 0039
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keep each import's progress (core.chat_imports) and
 *           |  which conversation became which thread
 *           |  (core.chat_import_items), so an import survives a
 *           |  restart and a conversation is never brought in twice.
 *  How      |  PgChatImportStore in Postgres, MemoryChatImportStore
 *           |  for tests.
 * ------------------------------------------------------------------
 */

import type { ChatImport, ChatImportOrigin, ChatImportStatus } from '@nvx/contracts';
import type { Sql } from 'postgres';

export interface ChatImportRecord extends ChatImport {
  workspace_id: string;
  /** Where the conversations were kept, so a restart can carry on. */
  file_path: string;
}

export type ChatImportPatch = Partial<
  Pick<
    ChatImportRecord,
    | 'status'
    | 'total'
    | 'done'
    | 'imported'
    | 'duplicates'
    | 'empty'
    | 'messages'
    | 'error'
    | 'finished_at'
    | 'origin'
  >
>;

export interface ChatImportStore {
  create(rec: ChatImportRecord): Promise<void>;
  get(id: string): Promise<ChatImportRecord | undefined>;
  update(id: string, patch: ChatImportPatch): Promise<void>;
  /** Newest first. */
  list(workspaceId: string, limit: number): Promise<ChatImportRecord[]>;
  /** Jobs that were queued or running when NVX Ancile last stopped. */
  unfinished(): Promise<ChatImportRecord[]>;
  /** The thread a conversation became, and by which import. */
  itemFor(
    workspaceId: string,
    origin: ChatImportOrigin,
    sourceId: string,
  ): Promise<{ thread_id: string; import_id: string } | undefined>;
  addItem(
    workspaceId: string,
    origin: ChatImportOrigin,
    sourceId: string,
    threadId: string,
    importId: string,
  ): Promise<void>;
}

export class MemoryChatImportStore implements ChatImportStore {
  readonly jobs = new Map<string, ChatImportRecord>();
  readonly items = new Map<string, { thread_id: string; import_id: string }>();
  private key = (w: string, o: string, s: string) => `${w}\u0000${o}\u0000${s}`;

  async create(rec: ChatImportRecord) {
    this.jobs.set(rec.id, structuredClone(rec));
  }
  async get(id: string) {
    const r = this.jobs.get(id);
    return r ? structuredClone(r) : undefined;
  }
  async update(id: string, patch: ChatImportPatch) {
    const r = this.jobs.get(id);
    if (r) Object.assign(r, patch);
  }
  async list(workspaceId: string, limit: number) {
    return [...this.jobs.values()]
      .filter((j) => j.workspace_id === workspaceId)
      .sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0))
      .slice(0, limit)
      .map((j) => structuredClone(j));
  }
  async unfinished() {
    return [...this.jobs.values()]
      .filter((j) => j.status === 'queued' || j.status === 'running')
      .map((j) => structuredClone(j));
  }
  async itemFor(w: string, o: ChatImportOrigin, s: string) {
    return this.items.get(this.key(w, o, s));
  }
  async addItem(w: string, o: ChatImportOrigin, s: string, threadId: string, importId: string) {
    this.items.set(this.key(w, o, s), { thread_id: threadId, import_id: importId });
  }
}

interface JobRow {
  id: string;
  workspace_id: string;
  origin: ChatImportOrigin;
  file_name: string | null;
  file_path: string;
  status: ChatImportStatus;
  total: number;
  done: number;
  imported: number;
  duplicates: number;
  empty: number;
  messages: number;
  notebook_id: string | null;
  error: ChatImport['error'];
  started_at: Date;
  finished_at: Date | null;
}

const fromRow = (r: JobRow): ChatImportRecord => ({
  id: r.id,
  workspace_id: r.workspace_id,
  origin: r.origin,
  file_name: r.file_name,
  file_path: r.file_path,
  status: r.status,
  total: r.total,
  done: r.done,
  imported: r.imported,
  duplicates: r.duplicates,
  empty: r.empty,
  messages: r.messages,
  notebook_id: r.notebook_id,
  error: r.error,
  started_at: r.started_at.toISOString(),
  finished_at: r.finished_at ? r.finished_at.toISOString() : null,
});

export class PgChatImportStore implements ChatImportStore {
  constructor(private readonly sql: Sql) {}

  async create(r: ChatImportRecord) {
    await this.sql`
      insert into core.chat_imports (id, workspace_id, origin, file_name, file_path, status, total, notebook_id, started_at)
      values (${r.id}, ${r.workspace_id}, ${r.origin}, ${r.file_name}, ${r.file_path}, ${r.status}, ${r.total},
        ${r.notebook_id}, ${r.started_at})`;
  }

  async get(id: string) {
    const rows = await this.sql<JobRow[]>`select * from core.chat_imports where id = ${id}`;
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async update(id: string, p: ChatImportPatch) {
    const cols: Record<string, unknown> = { ...p };
    if ('error' in p) cols.error = p.error ? this.sql.json(p.error as never) : null;
    const keys = Object.keys(cols);
    if (!keys.length) return;
    await this.sql`update core.chat_imports set ${this.sql(cols, ...keys)} where id = ${id}`;
  }

  async list(workspaceId: string, limit: number) {
    const rows = await this.sql<JobRow[]>`
      select * from core.chat_imports where workspace_id = ${workspaceId}
      order by started_at desc limit ${limit}`;
    return rows.map(fromRow);
  }

  async unfinished() {
    const rows = await this.sql<JobRow[]>`
      select * from core.chat_imports where status in ('queued', 'running') order by started_at`;
    return rows.map(fromRow);
  }

  async itemFor(workspaceId: string, origin: ChatImportOrigin, sourceId: string) {
    const rows = await this.sql<{ thread_id: string; import_id: string }[]>`
      select i.thread_id, i.import_id from core.chat_import_items i
      join core.threads t on t.id = i.thread_id and t.deleted_at is null
      where i.workspace_id = ${workspaceId} and i.origin = ${origin} and i.source_id = ${sourceId}`;
    return rows[0];
  }

  async addItem(w: string, o: ChatImportOrigin, s: string, threadId: string, importId: string) {
    await this.sql`
      insert into core.chat_import_items (workspace_id, origin, source_id, thread_id, import_id)
      values (${w}, ${o}, ${s}, ${threadId}, ${importId})
      on conflict (workspace_id, origin, source_id)
      do update set thread_id = excluded.thread_id, import_id = excluded.import_id`;
  }
}
