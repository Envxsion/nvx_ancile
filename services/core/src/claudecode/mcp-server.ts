/**
 * ------------------------------------------------------------------
 *  Title    |  NVX Ancile's MCP server for Claude Code
 *  Ref      |  docs/claude-code.md (Sources and citations) · lab/mcp-server.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Give a live Claude Code session the notebook's sources
 *           |  as its primary sources (search, read a source), what
 *           |  Ancile remembers, and the tools of every MCP server Core
 *           |  hosts, as one MCP server ("ancile" in the session's
 *           |  config). The session never holds a hosted server's
 *           |  secrets.
 *  How      |  Streamable HTTP at /mcp/claude, stateless (a fresh
 *           |  server per request, JSON answers), outside the browser
 *           |  guard. Each session gets a token for its own thread:
 *           |  "<thread id>.<HMAC of it under a per-boot secret>", so a
 *           |  call always knows its thread and notebook and cannot
 *           |  claim another. Every call is checked by the gate as
 *           |  agent:claude-code on its real arguments: the knowledge
 *           |  tools read the thread's notebook; a hosted tool on its
 *           |  own action, resource and tier, where "ask" runs only on
 *           |  the one-call pass the person's approval of that call
 *           |  left (the PreToolUse ask in claudecode/live.ts).
 *           |  search numbers its passages on from the turn's earlier
 *           |  searches and hands them to the live turn, so the answer's
 *           |  [n] markers become citations.
 *  Note     |  TODO(phase-3): push tools/list_changed (needs sessions,
 *           |  as /mcp/lab keeps); a session sees hosted servers added
 *           |  later on its next start.
 * ------------------------------------------------------------------
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { SearchHit, SearchResponse } from '@nvx/contracts';
import { currentContext, newTraceId, type RequestContext } from '../context';
import type { LabPasses } from '../lab/hosted';
import { hostedTool, hostedTools } from '../lab/hosted';
import { logFor } from '../obs/logger';
import { startSpan } from '../obs/spans';
import type { Gate } from '../permissions/gate';
import type { ToolRegistry, ToolSpec } from '../tools/registry';
import { CLAUDE_CODE_PRINCIPAL } from './permission-map';

const log = logFor('claude-mcp');

const PASSAGE_CHARS = 1_800;
const READ_CHARS = 20_000;

export interface Passage {
  marker: number;
  hit: SearchHit;
}

export interface ClaudeMcpDeps {
  /** Per-boot secret the session tokens are made with. */
  secret: string;
  registry: Pick<ToolRegistry, 'list' | 'get'>;
  gate: Gate;
  passes: LabPasses;
  userId: string;
  workspaceId: string;
  version: string;
  /** The thread's notebook (null when it has none), or null for an unknown thread. */
  thread(threadId: string): Promise<{ notebookId: string | null; notebookTitle: string | null } | null>;
  search(q: { notebookId: string; query: string; k: number; sourceIds?: string[] }): Promise<SearchResponse>;
  notebookSources(notebookId: string): Promise<{ id: string; title: string }[]>;
  sourceContent(sourceId: string): Promise<{ markdown: string }>;
  memorySearch?(q: string, limit: number): Promise<{ path: string; text: string; score: number }[]>;
  /** The live turn takes the passages and numbers them; absent or null: numbered from 1. */
  passages?(threadId: string, hits: SearchHit[]): Passage[] | null;
  /** The live turn's trace, so calls show under it. */
  traceOf?(threadId: string): RequestContext | null;
  /** Source ids the turn is grounded on (the send's source_ids), if any. */
  sourceIdsOf?(threadId: string): string[] | null;
}

const text = (t: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError && { isError }),
});

const json = (status: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="nvx-ancile-claude"' },
  });

function inputSchemaOf(t: ToolSpec): { type: 'object'; [k: string]: unknown } {
  const s = t.inputSchema as { type?: unknown } | null | undefined;
  if (s && typeof s === 'object' && s.type === 'object') return s as { type: 'object' };
  return { type: 'object', properties: {} };
}

/** The token a session for this thread carries. */
export function threadToken(secret: string, threadId: string): string {
  return `${threadId}.${createHmac('sha256', secret).update(threadId).digest('base64url')}`;
}

/** The thread a token is for, or null. */
export function tokenThread(secret: string, token: string): string | null {
  const at = token.lastIndexOf('.');
  if (at <= 0) return null;
  const threadId = token.slice(0, at);
  const want = Buffer.from(threadToken(secret, threadId));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got) ? threadId : null;
}

/** Passages as the model reads them. */
export function formatPassages(passages: Passage[]): string {
  return passages
    .map(({ marker, hit: h }) => {
      const where = [
        h.source_title,
        h.page != null ? `page ${h.page}` : null,
        h.heading_path.length ? h.heading_path.join(' › ') : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const body = h.text.length > PASSAGE_CHARS ? `${h.text.slice(0, PASSAGE_CHARS)}…` : h.text;
      return `[${marker}] ${where} (source ${h.source_id}, chunk ${h.chunk_id})\n"""\n${body.replace(/"""/g, '"​""')}\n"""`;
    })
    .join('\n\n');
}

const KNOWLEDGE_TOOLS = [
  {
    name: 'search',
    description:
      "Search this notebook's sources in NVX Ancile (its primary sources). Returns numbered passages; cite a passage you use by its [n] marker exactly as returned.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What to look for' },
        k: { type: 'integer', minimum: 1, maximum: 20, description: 'How many passages (default 8)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_source',
    description:
      "Read one of this notebook's sources in full (Markdown), a part at a time. Use the source id a search passage names.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        source_id: { type: 'string' },
        offset: { type: 'integer', minimum: 0, description: 'Character to start at (default 0)' },
        limit: {
          type: 'integer',
          minimum: 1000,
          maximum: 60000,
          description: 'Characters to read (default 20000)',
        },
      },
      required: ['source_id'],
    },
  },
  {
    name: 'memory_search',
    description: 'Search what NVX Ancile remembers about the user, their projects and past lessons.',
    inputSchema: {
      type: 'object' as const,
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 30 } },
      required: ['query'],
    },
  },
];

export class ClaudeMcpEndpoint {
  constructor(private readonly deps: ClaudeMcpDeps) {}

  readonly handle = async (req: Request): Promise<Response> => {
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    const threadId = token ? tokenThread(this.deps.secret, token) : null;
    if (!threadId) return json(401, 'This endpoint is for Claude Code sessions run by NVX Ancile only.');
    if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, 'Parse error: the body is not JSON.');
    }
    const server = this.serverFor(threadId);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req, { parsedBody: body });
    } finally {
      void server.close().catch(() => undefined);
    }
  };

  private serverFor(threadId: string): Server {
    const { deps } = this;
    const server = new Server({ name: 'nvx-ancile', version: deps.version }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        ...KNOWLEDGE_TOOLS.filter((t) => t.name !== 'memory_search' || deps.memorySearch),
        ...hostedTools(deps.registry).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: inputSchemaOf(t),
          annotations: {
            destructiveHint: t.destructive,
            ...(t.readOnly !== undefined && { readOnlyHint: t.readOnly }),
          },
        })),
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const parent = deps.traceOf?.(threadId) ?? currentContext() ?? null;
      const span = startSpan(
        `mcp ancile.${name}`,
        'server',
        { tool: name, thread_id: threadId },
        {
          parent: parent ?? undefined,
        },
      );
      try {
        const out = await this.call(threadId, name, args, extra.signal, parent?.traceId ?? newTraceId());
        span.end(out.isError ? 'error' : 'ok');
        return out;
      } catch (err) {
        span.end('error', { error: (err as Error).message });
        return text((err as Error).message || `${name} failed`, true);
      }
    });
    return server;
  }

  private async check(
    threadId: string,
    notebookId: string | null,
    a: { action: string; resource: string; tier: 'auto' | 'gated' | 'critical'; destructive: boolean },
    traceId: string,
  ) {
    return this.deps.gate.check({
      userId: this.deps.userId,
      principal: CLAUDE_CODE_PRINCIPAL,
      action: a.action,
      resource: a.resource,
      toolTier: a.tier,
      destructive: a.destructive,
      scope: { threadId, notebookId, workspaceId: this.deps.workspaceId },
      runId: null,
      traceId,
    });
  }

  private async call(
    threadId: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    traceId: string,
  ): Promise<CallToolResult> {
    const { deps } = this;
    const t = await deps.thread(threadId);
    if (!t) return text('This thread is no longer in NVX Ancile.', true);
    const notebookId = t.notebookId;
    const denied = (d: { outcome: string; reason?: string; via?: string; policyId?: string }) =>
      d.via === 'policy'
        ? `Not allowed: a policy blocks this (${d.policyId ?? 'policy'}).`
        : `Not allowed: ${d.reason ?? 'NVX Ancile said no'}`;

    if (name === 'search' || name === 'read_source') {
      if (!notebookId) return text('This thread is not in a notebook, so it has no sources to search.', true);
      const d = await this.check(
        threadId,
        notebookId,
        { action: 'knowledge.search', resource: `notebook:${notebookId}`, tier: 'auto', destructive: false },
        traceId,
      );
      if (d.outcome === 'deny') return text(denied(d), true);
      if (d.outcome === 'ask') return text('Searching the sources needs your approval in NVX Ancile.', true);
      if (name === 'search') {
        const query = typeof args.query === 'string' ? args.query.trim().slice(0, 2000) : '';
        if (!query) return text('Give a query.', true);
        const k = typeof args.k === 'number' ? Math.min(Math.max(Math.floor(args.k), 1), 20) : 8;
        const sourceIds = deps.sourceIdsOf?.(threadId) ?? undefined;
        const res = await deps.search({ notebookId, query, k, ...(sourceIds?.length && { sourceIds }) });
        if (!res.hits.length)
          return text(`Nothing in the sources of ${t.notebookTitle ?? 'this notebook'} matches that.`);
        const passages =
          deps.passages?.(threadId, res.hits) ?? res.hits.map((hit, i) => ({ marker: i + 1, hit }));
        return text(formatPassages(passages));
      }
      const sourceId = typeof args.source_id === 'string' ? args.source_id : '';
      const inNotebook = (await deps.notebookSources(notebookId)).some((s) => s.id === sourceId);
      if (!inNotebook) return text('That source is not in this notebook.', true);
      const { markdown } = await deps.sourceContent(sourceId);
      const offset = typeof args.offset === 'number' ? Math.max(0, Math.floor(args.offset)) : 0;
      const limit =
        typeof args.limit === 'number'
          ? Math.min(Math.max(Math.floor(args.limit), 1000), 60_000)
          : READ_CHARS;
      const part = markdown.slice(offset, offset + limit);
      const end = offset + part.length;
      return text(
        `Characters ${offset.toLocaleString('en-GB')}–${end.toLocaleString('en-GB')} of ${markdown.length.toLocaleString('en-GB')}${end < markdown.length ? ` (read on with offset ${end})` : ''}.\n\n${part}`,
      );
    }

    if (name === 'memory_search') {
      if (!deps.memorySearch) return text('Memory is not available.', true);
      const d = await this.check(
        threadId,
        notebookId,
        { action: 'memory.read', resource: 'memory:all', tier: 'auto', destructive: false },
        traceId,
      );
      if (d.outcome !== 'allow') return text(d.outcome === 'deny' ? denied(d) : 'Needs your approval.', true);
      const query = typeof args.query === 'string' ? args.query.slice(0, 500) : '';
      const hits = await deps.memorySearch(query, typeof args.limit === 'number' ? args.limit : 10);
      return text(
        hits.length
          ? hits.map((h) => `- ${h.text} (${h.path})`).join('\n')
          : 'Nothing remembered matches that.',
      );
    }

    const spec = hostedTool(deps.registry, name);
    if (!spec)
      return text(
        `There is no tool called "${name}" in NVX Ancile now. Its server may have been removed or be disconnected.`,
        true,
      );
    const scope = { workspaceId: deps.workspaceId };
    const d = await this.check(
      threadId,
      notebookId,
      {
        action: spec.action,
        resource: spec.resource(args, scope),
        tier: spec.tier,
        destructive: spec.destructive,
      },
      traceId,
    );
    if (d.outcome === 'deny') return text(denied(d), true);
    if (d.outcome === 'ask') {
      if (!deps.passes.take(spec.name))
        return text(`${spec.name} needs your approval in NVX Ancile; try the call again.`, true);
      log.info({ tool: spec.name }, 'hosted tool ran for Claude Code on a person’s approval');
    }
    const result = await spec.execute(args, {
      idempotencyKey: `claude-code:${randomUUID()}`,
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      scope,
    });
    return text(typeof result === 'string' ? result : JSON.stringify(result ?? null));
  }
}
