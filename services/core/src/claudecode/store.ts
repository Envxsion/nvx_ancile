/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code bindings
 *  Ref      |  docs/claude-code.md · migrations/0013_claude_code.sql,
 *           |  0014_claude_code_mapper.sql, 0018_claude_code_fork_lookup.sql
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Which notebook a folder's sessions go to, which thread
 *           |  each session was brought into (and by which version of
 *           |  the mapping), and which transcript entries a thread
 *           |  already holds.
 *  How      |  ClaudeCodeStore is the interface; PgClaudeCodeStore is
 *           |  real, MemoryClaudeCodeStore backs tests (over the memory
 *           |  thread repo). Folders are compared with cwdKey: on
 *           |  Windows case and slash direction do not matter.
 * ------------------------------------------------------------------
 */

import type { Sql } from 'postgres';
import type { MemoryThreadRepo } from '../threads/repo';
import type { CcProvenance, MirrorState } from './map';

/** A folder as the OS compares it. */
export function cwdKey(cwd: string, platform: NodeJS.Platform = process.platform): string {
  let k = cwd.trim();
  if (platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(k)) {
    k = k.replace(/\//g, '\\').replace(/\\+$/, '');
    if (/^[a-zA-Z]:$/.test(k)) k += '\\';
    return k.toLowerCase();
  }
  return k.length > 1 ? k.replace(/\/+$/, '') : k;
}

/** Is `cwd` the folder `root` or inside it (whole path segments only)? */
export function cwdWithin(cwd: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const a = cwdKey(cwd, platform);
  const b = cwdKey(root, platform);
  if (!b) return false;
  if (a === b) return true;
  const sep = b.includes('\\') || platform === 'win32' ? '\\' : '/';
  return a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);
}

export interface ProjectBinding {
  cwd: string;
  cwd_key: string;
  notebook_id: string;
  /** The notebook was made for this folder (not adopted or chosen). */
  created_notebook: boolean;
}

export interface SessionBinding {
  session_id: string;
  thread_id: string;
  /** The title Ancile last gave the thread. */
  title: string | null;
  cwd: string | null;
  /** Transcript modified time (ms) at the last sync. */
  last_modified: number;
  synced_at: string;
  /** map.ts MAPPER_VERSION the thread was built with. */
  mapper_version: number;
}

export interface ClaudeCodeStore {
  projects(workspaceId: string): Promise<ProjectBinding[]>;
  putProject(
    workspaceId: string,
    cwd: string,
    notebookId: string,
    created?: boolean,
  ): Promise<ProjectBinding>;
  removeProject(workspaceId: string, cwd: string): Promise<boolean>;
  /** Sessions whose thread still exists (archived threads included). */
  sessions(workspaceId: string): Promise<SessionBinding[]>;
  putSession(workspaceId: string, s: SessionBinding): Promise<void>;
  removeSession(workspaceId: string, sessionId: string): Promise<boolean>;
  /** What a thread already mirrors. */
  mirror(threadId: string): Promise<MirrorState>;
  /**
   * The thread (not deleted) that already holds the most of these Claude
   * Code entry uuids, if any: a session forked in a terminal (/branch)
   * shares its entries with the session it came from.
   */
  threadHolding(workspaceId: string, uuids: string[]): Promise<string | null>;
}

/** How many of a session's first entries are looked up to tell a fork. */
export const FORK_PROBE = 50;

interface MirrorRow {
  id: string;
  parent_id: string | null;
  role: string;
  cc: (CcProvenance & Record<string, unknown>) | null;
}

function buildMirror(rows: MirrorRow[]): MirrorState {
  const byUuid = new Map<string, string>();
  const messages: MirrorState['messages'] = new Map();
  const parents = new Set(rows.map((r) => r.parent_id).filter((p): p is string => !!p));
  for (const r of rows) {
    if (!r.cc || !Array.isArray(r.cc.uuids)) continue;
    for (const u of r.cc.uuids) if (typeof u === 'string') byUuid.set(u, r.id);
    messages.set(r.id, {
      role: r.role,
      lastUuid: String(r.cc.uuid ?? r.cc.uuids.at(-1) ?? ''),
      hasChildren: parents.has(r.id),
      lastApiId: typeof r.cc.last_api_id === 'string' ? r.cc.last_api_id : null,
      kind: typeof r.cc.kind === 'string' ? r.cc.kind : null,
    });
  }
  return { byUuid, messages };
}

export class PgClaudeCodeStore implements ClaudeCodeStore {
  constructor(
    private readonly sql: Sql,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async projects(workspaceId: string) {
    return this.sql<ProjectBinding[]>`
      select p.cwd, p.cwd_key, p.notebook_id, p.created_notebook from core.claude_code_projects p
      join core.notebooks n on n.id = p.notebook_id and n.deleted_at is null
      where p.workspace_id = ${workspaceId} order by p.cwd`.then((r) => [...r]);
  }

  async putProject(workspaceId: string, cwd: string, notebookId: string, created = false) {
    const key = cwdKey(cwd, this.platform);
    await this.sql`
      insert into core.claude_code_projects (workspace_id, cwd_key, cwd, notebook_id, created_notebook)
      values (${workspaceId}, ${key}, ${cwd}, ${notebookId}, ${created})
      on conflict (workspace_id, cwd_key) do update set cwd = excluded.cwd, notebook_id = excluded.notebook_id,
        created_notebook = excluded.created_notebook, updated_at = now()`;
    return { cwd, cwd_key: key, notebook_id: notebookId, created_notebook: created };
  }

  async removeProject(workspaceId: string, cwd: string) {
    const r = await this.sql`
      delete from core.claude_code_projects where workspace_id = ${workspaceId} and cwd_key = ${cwdKey(cwd, this.platform)}
      returning cwd`;
    return r.length > 0;
  }

  async sessions(workspaceId: string) {
    const rows = await this.sql<
      (Omit<SessionBinding, 'last_modified' | 'synced_at'> & { last_modified: string; synced_at: Date })[]
    >`
      select s.session_id, s.thread_id, s.title, s.cwd, s.last_modified, s.synced_at, s.mapper_version
      from core.claude_code_sessions s join core.threads t on t.id = s.thread_id and t.deleted_at is null
      where s.workspace_id = ${workspaceId}`;
    return rows.map((r) => ({
      ...r,
      last_modified: Number(r.last_modified),
      synced_at: r.synced_at.toISOString(),
      mapper_version: Number(r.mapper_version),
    }));
  }

  async putSession(workspaceId: string, s: SessionBinding) {
    await this.sql`
      insert into core.claude_code_sessions (workspace_id, session_id, thread_id, title, cwd, last_modified, synced_at, mapper_version)
      values (${workspaceId}, ${s.session_id}, ${s.thread_id}, ${s.title}, ${s.cwd}, ${s.last_modified}, ${s.synced_at}, ${s.mapper_version})
      on conflict (workspace_id, session_id) do update set thread_id = excluded.thread_id, title = excluded.title,
        cwd = excluded.cwd, last_modified = excluded.last_modified, synced_at = excluded.synced_at,
        mapper_version = excluded.mapper_version`;
  }

  async removeSession(workspaceId: string, sessionId: string) {
    const r = await this.sql`
      delete from core.claude_code_sessions where workspace_id = ${workspaceId} and session_id = ${sessionId}
      returning session_id`;
    return r.length > 0;
  }

  async mirror(threadId: string) {
    const rows = await this.sql<MirrorRow[]>`
      select id, parent_id, role, provenance->'claude_code' as cc
      from core.messages where thread_id = ${threadId} and deleted_at is null`;
    return buildMirror([...rows]);
  }

  async threadHolding(workspaceId: string, uuids: string[]) {
    if (!uuids.length) return null;
    const rows = await this.sql<{ thread_id: string }[]>`
      select m.thread_id, count(*)::int as n from core.messages m
      join core.threads t on t.id = m.thread_id and t.deleted_at is null
      where t.workspace_id = ${workspaceId} and m.deleted_at is null and m.provenance ? 'claude_code'
        and (m.provenance->'claude_code'->'uuids') ?| ${uuids}::text[]
      group by m.thread_id order by n desc, m.thread_id limit 1`;
    return rows[0]?.thread_id ?? null;
  }
}

export class MemoryClaudeCodeStore implements ClaudeCodeStore {
  private readonly proj = new Map<string, ProjectBinding & { ws: string }>();
  private readonly sess = new Map<string, SessionBinding & { ws: string }>();

  constructor(
    private readonly threads: MemoryThreadRepo,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async projects(workspaceId: string) {
    return [...this.proj.values()]
      .filter((p) => p.ws === workspaceId)
      .map(({ ws: _w, ...p }) => p)
      .sort((a, b) => a.cwd.localeCompare(b.cwd));
  }

  async putProject(workspaceId: string, cwd: string, notebookId: string, created = false) {
    const key = cwdKey(cwd, this.platform);
    const b = { cwd, cwd_key: key, notebook_id: notebookId, created_notebook: created };
    this.proj.set(`${workspaceId}|${key}`, { ...b, ws: workspaceId });
    return b;
  }

  async removeProject(workspaceId: string, cwd: string) {
    return this.proj.delete(`${workspaceId}|${cwdKey(cwd, this.platform)}`);
  }

  async sessions(workspaceId: string) {
    const out: SessionBinding[] = [];
    for (const s of this.sess.values()) {
      if (s.ws !== workspaceId || !(await this.threads.getThread(s.thread_id))) continue;
      const { ws: _w, ...rest } = s;
      out.push(rest);
    }
    return out;
  }

  async putSession(workspaceId: string, s: SessionBinding) {
    this.sess.set(`${workspaceId}|${s.session_id}`, { ...s, ws: workspaceId });
  }

  async removeSession(workspaceId: string, sessionId: string) {
    return this.sess.delete(`${workspaceId}|${sessionId}`);
  }

  async mirror(threadId: string) {
    const msgs = await this.threads.messages(threadId);
    return buildMirror(
      msgs.map((m) => ({
        id: m.id,
        parent_id: m.parent_id,
        role: m.role,
        cc: (m.provenance?.claude_code as MirrorRow['cc']) ?? null,
      })),
    );
  }

  async threadHolding(workspaceId: string, uuids: string[]) {
    if (!uuids.length) return null;
    const want = new Set(uuids);
    const counts = new Map<string, number>();
    const all = [
      ...(await this.threads.listThreads(workspaceId, { limit: 10_000 })),
      ...(await this.threads.listThreads(workspaceId, { limit: 10_000, archived: true })),
    ];
    for (const t of all) {
      for (const m of await this.threads.messages(t.id)) {
        const cc = m.provenance?.claude_code as { uuids?: unknown } | undefined;
        if (!Array.isArray(cc?.uuids)) continue;
        const n = cc.uuids.filter((u) => typeof u === 'string' && want.has(u)).length;
        if (n) counts.set(t.id, (counts.get(t.id) ?? 0) + n);
      }
    }
    let best: string | null = null;
    for (const [id, n] of counts) if (!best || n > (counts.get(best) ?? 0)) best = id;
    return best;
  }
}
