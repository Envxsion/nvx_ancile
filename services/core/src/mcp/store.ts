/**
 * ------------------------------------------------------------------
 *  Title    |  MCP servers added in the app
 *  Ref      |  docs/plugins.md · packages/contracts/src/mcp.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Keep the servers people add in Admin → Plugins: how to
 *           |  reach them, plain env or headers, which secrets they
 *           |  have, and per-tool overrides.
 *  How      |  core.mcp_servers in Postgres; MemoryMcpServerStore for
 *           |  tests. Secret values never live here: `secret_keys` lists
 *           |  the env vars or headers, and the values sit in the
 *           |  encrypted secret store (see service.ts for the names).
 *  Note     |  The env_secret_ids column holds the secret keys for both
 *           |  transports (env vars for stdio, headers for http).
 * ------------------------------------------------------------------
 */

import type { Sql } from 'postgres';
import type { ToolOverride } from '../tools/registry';

export interface McpServerRow {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  secret_keys: string[];
  enabled: boolean;
  tool_overrides: Record<string, ToolOverride>;
  created_at: string;
}

export type McpServerPatch = Partial<Omit<McpServerRow, 'id' | 'transport' | 'created_at'>>;

export interface McpServerStore {
  list(): Promise<McpServerRow[]>;
  get(id: string): Promise<McpServerRow | undefined>;
  byName(name: string): Promise<McpServerRow | undefined>;
  /** False when the name is taken. */
  create(row: Omit<McpServerRow, 'created_at'>): Promise<boolean>;
  /** Undefined when the id is unknown; false when a rename hits a taken name. */
  update(id: string, patch: McpServerPatch): Promise<McpServerRow | undefined | false>;
  remove(id: string): Promise<boolean>;
}

export class MemoryMcpServerStore implements McpServerStore {
  private rows = new Map<string, McpServerRow>();

  async list() {
    return [...this.rows.values()]
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .map((r) => structuredClone(r));
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r && structuredClone(r);
  }
  async byName(name: string) {
    const r = [...this.rows.values()].find((x) => x.name === name);
    return r && structuredClone(r);
  }
  async create(row: Omit<McpServerRow, 'created_at'>) {
    if ([...this.rows.values()].some((x) => x.name === row.name)) return false;
    this.rows.set(row.id, structuredClone({ ...row, created_at: new Date().toISOString() }));
    return true;
  }
  async update(id: string, patch: McpServerPatch) {
    const r = this.rows.get(id);
    if (!r) return undefined;
    if (patch.name && [...this.rows.values()].some((x) => x.name === patch.name && x.id !== id)) return false;
    const next = structuredClone({ ...r, ...patch });
    this.rows.set(id, next);
    return structuredClone(next);
  }
  async remove(id: string) {
    return this.rows.delete(id);
  }
}

interface Row {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[] | null;
  env: Record<string, string> | null;
  url: string | null;
  headers: Record<string, string> | null;
  env_secret_ids: string[] | null;
  enabled: boolean;
  tool_overrides: Record<string, ToolOverride> | null;
  created_at: Date;
}

const fromRow = (r: Row): McpServerRow => ({
  id: r.id,
  name: r.name,
  transport: r.transport,
  command: r.command,
  args: r.args ?? [],
  env: r.env ?? {},
  url: r.url,
  headers: r.headers ?? {},
  secret_keys: r.env_secret_ids ?? [],
  enabled: r.enabled,
  tool_overrides: r.tool_overrides ?? {},
  created_at: r.created_at.toISOString(),
});

const UNIQUE_VIOLATION = '23505';
const isUnique = (err: unknown) => (err as { code?: string }).code === UNIQUE_VIOLATION;

export class PgMcpServerStore implements McpServerStore {
  constructor(private readonly sql: Sql) {}

  async list() {
    const rows = await this.sql<Row[]>`select * from core.mcp_servers order by created_at, id`;
    return rows.map(fromRow);
  }

  async get(id: string) {
    const [r] = await this.sql<Row[]>`select * from core.mcp_servers where id = ${id}`;
    return r && fromRow(r);
  }

  async byName(name: string) {
    const [r] = await this.sql<Row[]>`select * from core.mcp_servers where name = ${name}`;
    return r && fromRow(r);
  }

  async create(row: Omit<McpServerRow, 'created_at'>) {
    const j = (v: unknown) => this.sql.json(v as never);
    try {
      await this.sql`
        insert into core.mcp_servers
          (id, name, transport, command, args, env, url, headers, env_secret_ids, enabled, tool_overrides)
        values (${row.id}, ${row.name}, ${row.transport}, ${row.command}, ${j(row.args)}, ${j(row.env)},
                ${row.url}, ${j(row.headers)}, ${this.sql.array(row.secret_keys)}::text[], ${row.enabled},
                ${j(row.tool_overrides)})`;
      return true;
    } catch (err) {
      if (isUnique(err)) return false;
      throw err;
    }
  }

  async update(id: string, patch: McpServerPatch) {
    const prev = await this.get(id);
    if (!prev) return undefined;
    const n = { ...prev, ...patch };
    const j = (v: unknown) => this.sql.json(v as never);
    try {
      const [r] = await this.sql<Row[]>`
        update core.mcp_servers set
          name = ${n.name}, command = ${n.command}, args = ${j(n.args)}, env = ${j(n.env)},
          url = ${n.url}, headers = ${j(n.headers)}, env_secret_ids = ${this.sql.array(n.secret_keys)}::text[],
          enabled = ${n.enabled}, tool_overrides = ${j(n.tool_overrides)}, updated_at = now()
        where id = ${id}
        returning *`;
      return r && fromRow(r);
    } catch (err) {
      if (isUnique(err)) return false;
      throw err;
    }
  }

  async remove(id: string) {
    const rows = await this.sql`delete from core.mcp_servers where id = ${id} returning id`;
    return rows.length > 0;
  }
}
