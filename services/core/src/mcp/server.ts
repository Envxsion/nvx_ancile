/**
 * ------------------------------------------------------------------
 *  Title    |  NVX Ancile as an MCP server
 *  Ref      |  DESIGN.md §4.4 · ROADMAP Phase 5
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Let another app (an editor, a desktop assistant) search
 *           |  your notebooks and memory through MCP, and nothing more
 *           |  than you allowed it.
 *  How      |  Streamable HTTP at /mcp, stateless (a fresh server per
 *           |  request, JSON responses), behind a bearer token you
 *           |  create in Admin → Plugins. Each app is its own principal
 *           |  (mcp:<id>), and every tool call goes through the same
 *           |  permission gate as the assistant's own, on the real
 *           |  arguments: the grants made when you connected the app
 *           |  are what allows it, and revoking one in Admin → Grants
 *           |  takes effect on the next call. A stdio bridge
 *           |  (mcp/stdio.ts) serves clients that only speak stdio.
 *  Note     |  Only a SHA-256 of each token is stored.
 * ------------------------------------------------------------------
 */

import { createHash, randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { McpClientView, SearchResponse } from '@nvx/contracts';
import type { Sql } from 'postgres';
import { ulid } from 'ulid';
import { z } from 'zod';
import { currentContext, newTraceId } from '../context';
import { logFor } from '../obs/logger';
import { withSpan } from '../obs/spans';
import type { Gate } from '../permissions/gate';
import type { PermissionStore } from '../permissions/store';

const log = logFor('mcp-server');

/** The tools an app can be given, and the permission action each one needs. */
export const SERVED_TOOLS = {
  'ancile.search': { action: 'knowledge.search', title: 'Search your sources' },
  'ancile.notebooks': { action: 'notebooks.read', title: 'List your notebooks' },
  'ancile.memory_search': { action: 'memory.read', title: 'Search your memory' },
} as const;
export type ServedTool = keyof typeof SERVED_TOOLS;

export interface McpClientRecord {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface McpClientStore {
  create(name: string, tokenHash: string): Promise<McpClientRecord>;
  byHash(tokenHash: string): Promise<McpClientRecord | undefined>;
  list(): Promise<McpClientRecord[]>;
  revoke(id: string): Promise<boolean>;
  touch(id: string): Promise<void>;
}

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export interface ServerDeps {
  clients: McpClientStore;
  gate: Gate;
  permissions: Pick<PermissionStore, 'createGrant' | 'listGrants' | 'revokeGrant'>;
  userId: string;
  workspaceId: string;
  version: string;
  search?: (q: { query: string; notebookId?: string; k: number }) => Promise<SearchResponse>;
  notebooks?: () => Promise<{ id: string; title: string; description: string | null }[]>;
  memorySearch?: (q: string, limit: number) => Promise<{ path: string; text: string; score: number }[]>;
}

const principalOf = (clientId: string) => `mcp:${clientId}`;

/** Create an app's token and its grants. The token is returned once, here. */
export async function connectClient(
  deps: Pick<ServerDeps, 'clients' | 'permissions' | 'userId'>,
  name: string,
  tools: string[],
): Promise<{ client: McpClientRecord; token: string }> {
  const token = `anc_mcp_${randomBytes(24).toString('base64url')}`;
  const client = await deps.clients.create(name, hashToken(token));
  for (const t of tools) {
    const spec = SERVED_TOOLS[t as ServedTool];
    if (!spec) continue;
    await deps.permissions.createGrant({
      userId: deps.userId,
      principal: principalOf(client.id),
      actionPattern: spec.action,
      resourcePattern: '*',
      effect: 'allow',
      scope: 'always',
      scopeRef: null,
      expiresAt: null,
      fromApprovalId: null,
    });
  }
  return { client, token };
}

export async function clientViews(
  deps: Pick<ServerDeps, 'clients' | 'permissions'>,
): Promise<McpClientView[]> {
  const [clients, grants] = await Promise.all([deps.clients.list(), deps.permissions.listGrants()]);
  return clients
    .filter((c) => !c.revoked_at)
    .map((c) => {
      const actions = new Set(
        grants
          .filter((g) => g.principal === principalOf(c.id) && !g.revoked_at && g.effect === 'allow')
          .map((g) => g.action_pattern),
      );
      return {
        id: c.id,
        name: c.name,
        created_at: c.created_at,
        last_used_at: c.last_used_at,
        tools: Object.entries(SERVED_TOOLS)
          .filter(([, s]) => actions.has(s.action) || actions.has('*'))
          .map(([name]) => name),
      };
    });
}

export async function disconnectClient(
  deps: Pick<ServerDeps, 'clients' | 'permissions'>,
  id: string,
): Promise<boolean> {
  const ok = await deps.clients.revoke(id);
  if (!ok) return false;
  for (const g of await deps.permissions.listGrants())
    if (g.principal === principalOf(id) && !g.revoked_at) await deps.permissions.revokeGrant(g.id);
  return true;
}

type ToolText = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): ToolText => ({
  content: [{ type: 'text', text: t }],
  ...(isError && { isError }),
});

/** One stateless MCP server for one request from one app. */
function serverFor(deps: ServerDeps, client: McpClientRecord): McpServer {
  const server = new McpServer({ name: 'nvx-ancile', version: deps.version });

  const allowed = async (tool: ServedTool, resource: string): Promise<string | null> => {
    const decision = await deps.gate.check({
      userId: deps.userId,
      principal: principalOf(client.id),
      action: SERVED_TOOLS[tool].action,
      resource,
      toolTier: 'gated',
      destructive: false,
      scope: { workspaceId: deps.workspaceId },
      runId: null,
      traceId: currentContext()?.traceId ?? newTraceId(),
    });
    if (decision.outcome === 'allow') return null;
    return decision.outcome === 'deny'
      ? `Not allowed: ${decision.reason}`
      : `${client.name} is not allowed to use ${tool}. Give it access in NVX Ancile → Admin → Plugins.`;
  };

  if (deps.search) {
    const search = deps.search;
    server.registerTool(
      'ancile.search',
      {
        title: SERVED_TOOLS['ancile.search'].title,
        description:
          'Search the sources in NVX Ancile (documents, web pages, notes, past threads). Returns the best passages with their source and page.',
        inputSchema: {
          query: z.string().min(1).max(2000).describe('What to look for'),
          notebook_id: z.string().optional().describe('Search one notebook only (ids from ancile.notebooks)'),
          k: z.number().int().min(1).max(20).optional().describe('How many passages (default 8)'),
        },
      },
      async ({ query, notebook_id, k }) => {
        const denied = await allowed(
          'ancile.search',
          notebook_id ? `notebook:${notebook_id}` : `workspace:${deps.workspaceId}`,
        );
        if (denied) return text(denied, true);
        const res = await search({ query, ...(notebook_id && { notebookId: notebook_id }), k: k ?? 8 });
        if (!res.hits.length) return text('Nothing in your sources matches that.');
        return text(
          res.hits
            .map(
              (h, i) =>
                `[${i + 1}] ${h.source_title}${h.page != null ? `, page ${h.page}` : ''}${h.heading_path.length ? ` · ${h.heading_path.join(' › ')}` : ''}\n${h.text}`,
            )
            .join('\n\n'),
        );
      },
    );
  }

  if (deps.notebooks) {
    const notebooks = deps.notebooks;
    server.registerTool(
      'ancile.notebooks',
      {
        title: SERVED_TOOLS['ancile.notebooks'].title,
        description: 'List the notebooks in NVX Ancile, with their ids.',
      },
      async () => {
        const denied = await allowed('ancile.notebooks', `workspace:${deps.workspaceId}`);
        if (denied) return text(denied, true);
        const list = await notebooks();
        return text(
          list.length
            ? list.map((n) => `${n.id}  ${n.title}${n.description ? ` · ${n.description}` : ''}`).join('\n')
            : 'There are no notebooks yet.',
        );
      },
    );
  }

  if (deps.memorySearch) {
    const memorySearch = deps.memorySearch;
    server.registerTool(
      'ancile.memory_search',
      {
        title: SERVED_TOOLS['ancile.memory_search'].title,
        description: 'Search what NVX Ancile remembers about the user, their projects and past lessons.',
        inputSchema: { query: z.string().min(1).max(500), limit: z.number().int().min(1).max(30).optional() },
      },
      async ({ query, limit }) => {
        const denied = await allowed('ancile.memory_search', 'memory:all');
        if (denied) return text(denied, true);
        const hits = await memorySearch(query, limit ?? 10);
        return text(
          hits.length
            ? hits.map((h) => `- ${h.text} (${h.path})`).join('\n')
            : 'Nothing remembered matches that.',
        );
      },
    );
  }
  return server;
}

const unauthorised = (message: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="nvx-ancile"' },
  });

/** The /mcp endpoint. */
export function mcpEndpoint(deps: ServerDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const auth = req.headers.get('authorization') ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
    if (!token) return unauthorised('Send the token from NVX Ancile → Admin → Plugins as a Bearer token.');
    const client = await deps.clients.byHash(hashToken(token));
    if (!client || client.revoked_at)
      return unauthorised('That token is not known, or the app was disconnected.');
    void deps.clients.touch(client.id).catch(() => undefined);
    return withSpan('mcp request', 'server', { mcp_client: client.name }, async () => {
      const server = serverFor(deps, client);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(req);
      } catch (err) {
        log.error({ err, client: client.id }, 'an MCP request failed');
        throw err;
      } finally {
        // Stateless: nothing outlives the request.
        void server.close().catch(() => undefined);
      }
    });
  };
}

/* ---- Stores --------------------------------------------------------------------- */

export class MemoryMcpClientStore implements McpClientStore {
  rows = new Map<string, McpClientRecord & { hash: string }>();
  async create(name: string, tokenHash: string) {
    const r = {
      id: `mcc_${ulid()}`,
      name,
      hash: tokenHash,
      created_at: new Date().toISOString(),
      last_used_at: null,
      revoked_at: null,
    };
    this.rows.set(r.id, r);
    const { hash: _h, ...view } = r;
    return view;
  }
  async byHash(h: string) {
    const r = [...this.rows.values()].find((x) => x.hash === h);
    if (!r) return undefined;
    const { hash: _h, ...view } = r;
    return view;
  }
  async list() {
    return [...this.rows.values()].map(({ hash: _h, ...v }) => v);
  }
  async revoke(id: string) {
    const r = this.rows.get(id);
    if (!r || r.revoked_at) return false;
    r.revoked_at = new Date().toISOString();
    return true;
  }
  async touch(id: string) {
    const r = this.rows.get(id);
    if (r) r.last_used_at = new Date().toISOString();
  }
}

interface ClientRow {
  id: string;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}
const view = (r: ClientRow): McpClientRecord => ({
  id: r.id,
  name: r.name,
  created_at: r.created_at.toISOString(),
  last_used_at: r.last_used_at?.toISOString() ?? null,
  revoked_at: r.revoked_at?.toISOString() ?? null,
});

export class PgMcpClientStore implements McpClientStore {
  constructor(private readonly sql: Sql) {}
  async create(name: string, tokenHash: string) {
    const [r] = await this.sql<ClientRow[]>`
      insert into core.mcp_clients (id, name, token_hash) values (${`mcc_${ulid()}`}, ${name}, ${tokenHash})
      returning id, name, created_at, last_used_at, revoked_at`;
    return view(r as ClientRow);
  }
  async byHash(h: string) {
    const [r] = await this.sql<ClientRow[]>`
      select id, name, created_at, last_used_at, revoked_at from core.mcp_clients where token_hash = ${h}`;
    return r ? view(r) : undefined;
  }
  async list() {
    const rows = await this.sql<ClientRow[]>`
      select id, name, created_at, last_used_at, revoked_at from core.mcp_clients order by created_at desc`;
    return rows.map(view);
  }
  async revoke(id: string) {
    const res = await this
      .sql`update core.mcp_clients set revoked_at = now() where id = ${id} and revoked_at is null`;
    return res.count === 1;
  }
  async touch(id: string) {
    await this.sql`update core.mcp_clients set last_used_at = now() where id = ${id}`;
  }
}
