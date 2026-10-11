/**
 * ------------------------------------------------------------------
 *  Title    |  The lab's MCP server
 *  Ref      |  DESIGN.md §5, vendor/opencode/PATCHES.md (patch 5)
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Give the lab the tools of every MCP server Core hosts,
 *           |  as one remote MCP server ("ancile" in the lab's config),
 *           |  so the lab never holds a server's secrets and every
 *           |  call still passes Core's permission gate.
 *  How      |  Streamable HTTP at /mcp/lab, behind the lab's gateway
 *           |  token (the one Core already gives the lab for model
 *           |  calls). tools/list is read from the tool registry on
 *           |  every request, so it is never stale. tools/call runs the
 *           |  gate on the real arguments as agent:lab, with the
 *           |  hosted tool's own action, resource and tier: allowed
 *           |  runs, denied answers isError with the reason, and "ask"
 *           |  runs only on a pass a person's approval left in the
 *           |  permission bridge (lab/hosted.ts).
 *           |  A client that initialises gets a session, kept in memory,
 *           |  and its event stream is told tools/list_changed when a
 *           |  server is added, removed, connects or drops. A request
 *           |  for a session Core no longer knows (after a restart) is
 *           |  served statelessly, so the lab keeps working; it simply
 *           |  hears no more pushes until it reconnects.
 *  Note     |  Only hosted MCP tools are offered: built-ins stay with
 *           |  the lab's own tools, which ask through the bridge.
 * ------------------------------------------------------------------
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  isInitializeRequest,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { currentContext, newTraceId } from '../context';
import { logFor } from '../obs/logger';
import type { Gate } from '../permissions/gate';
import type { ToolRegistry, ToolSpec } from '../tools/registry';
import { LAB_PRINCIPAL } from './event-mirror';
import { hostedTool, hostedTools, type LabPasses } from './hosted';

const log = logFor('lab-mcp');

export interface LabMcpDeps {
  registry: Pick<ToolRegistry, 'list' | 'get' | 'onChange'>;
  gate: Gate;
  passes: LabPasses;
  /** The lab's token (AGENT_GATEWAY_TOKEN). */
  token: string;
  userId: string;
  workspaceId: string;
  version: string;
  /** Sessions kept at once; the least recently used is closed beyond this (default 32). */
  maxSessions?: number;
  /** How long one call may run (default 60 s). */
  toolTimeoutMs?: number;
  /** How long change notifications wait, so a server's burst of tools sends one (default 100 ms). */
  notifyDelayMs?: number;
}

interface Session {
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  seen: number;
}

const json = (status: number, code: number, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function sameSecret(a: string, b: string): boolean {
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

const text = (t: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError && { isError }),
});

function inputSchemaOf(t: ToolSpec): { type: 'object'; [k: string]: unknown } {
  const s = t.inputSchema as { type?: unknown } | null | undefined;
  if (s && typeof s === 'object' && s.type === 'object') return s as { type: 'object' };
  return { type: 'object', properties: {} };
}

export class LabMcpEndpoint {
  private readonly sessions = new Map<string, Session>();
  private readonly stopListening: () => void;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: LabMcpDeps) {
    this.stopListening = deps.registry.onChange(() => this.scheduleNotify());
  }

  /** Sessions open now (for tests and the health view). */
  get open(): number {
    return this.sessions.size;
  }

  readonly handle = async (req: Request): Promise<Response> => {
    const auth = req.headers.get('authorization') ?? '';
    if (!sameSecret(auth, `Bearer ${this.deps.token}`))
      return json(401, -32001, 'This endpoint is for the NVX Ancile lab only.', {
        'www-authenticate': 'Bearer realm="nvx-ancile-lab"',
      });

    const sid = req.headers.get('mcp-session-id');
    const known = sid ? this.sessions.get(sid) : undefined;
    if (known) {
      known.seen = Date.now();
      return known.transport.handleRequest(req);
    }

    if (req.method === 'GET')
      return json(405, -32000, 'No event stream for this session.', { allow: 'POST' });
    if (req.method === 'DELETE') return new Response(null, { status: sid ? 404 : 405 });
    if (req.method !== 'POST') return json(405, -32000, 'Method not allowed.', { allow: 'POST' });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, -32700, 'Parse error: the body is not JSON.');
    }
    const initialising = Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body);
    if (!sid && initialising) return this.openSession(req, body);
    // A session Core does not know (a restart, or one closed to make room):
    // answer this request on its own, so the lab's tools keep working.
    return this.statelessly(req, body);
  };

  /** Stop listening for registry changes and close every session. */
  async close(): Promise<void> {
    this.stopListening();
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.server.close().catch(() => undefined)));
  }

  private async openSession(req: Request, body: unknown): Promise<Response> {
    const server = this.serverFor();
    const session: Session = {
      server,
      transport: new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          this.sessions.set(id, session);
          this.evict();
        },
        onsessionclosed: (id) => {
          this.sessions.delete(id);
        },
      }),
      seen: Date.now(),
    };
    await server.connect(session.transport);
    return session.transport.handleRequest(req, { parsedBody: body });
  }

  private async statelessly(req: Request, body: unknown): Promise<Response> {
    const server = this.serverFor();
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
  }

  private evict(): void {
    const max = this.deps.maxSessions ?? 32;
    while (this.sessions.size > max) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].seen - b[1].seen)[0];
      if (!oldest) return;
      this.sessions.delete(oldest[0]);
      void oldest[1].server.close().catch(() => undefined);
    }
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      for (const s of this.sessions.values())
        void s.server.sendToolListChanged().catch((err: unknown) => {
          log.debug({ err: (err as Error).message }, 'could not tell a lab session its tools changed');
        });
    }, this.deps.notifyDelayMs ?? 100);
    this.notifyTimer.unref?.();
  }

  private serverFor(): Server {
    const { deps } = this;
    const server = new Server(
      { name: 'nvx-ancile-lab', version: deps.version },
      { capabilities: { tools: { listChanged: true } } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: hostedTools(deps.registry).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: inputSchemaOf(t),
        annotations: {
          destructiveHint: t.destructive,
          ...(t.readOnly !== undefined && { readOnlyHint: t.readOnly }),
        },
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      const spec = hostedTool(deps.registry, name);
      if (!spec)
        return text(
          `There is no tool called "${name}" in NVX Ancile now. Its server may have been removed or be disconnected.`,
          true,
        );
      const scope = { workspaceId: deps.workspaceId };
      const decision = await deps.gate.check({
        userId: deps.userId,
        principal: LAB_PRINCIPAL,
        action: spec.action,
        resource: spec.resource(args, scope),
        toolTier: spec.tier,
        destructive: spec.destructive,
        scope,
        runId: null,
        traceId: currentContext()?.traceId ?? newTraceId(),
      });
      if (decision.outcome === 'deny')
        return text(
          decision.via === 'policy'
            ? `Not allowed: a policy blocks this (${decision.policyId ?? 'policy'}).`
            : `Not allowed: ${decision.reason}`,
          true,
        );
      if (decision.outcome === 'ask') {
        if (!deps.passes.take(spec.name))
          return text(
            `${spec.name} needs your approval in NVX Ancile. The lab asks for it when it uses the tool; try the call again.`,
            true,
          );
        log.info({ tool: spec.name }, 'hosted tool ran for the lab on a person’s approval');
      }
      const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(deps.toolTimeoutMs ?? 60_000)]);
      try {
        const result = await spec.execute(args, {
          idempotencyKey: `lab:${randomUUID()}`,
          signal,
          scope,
        });
        return text(typeof result === 'string' ? result : JSON.stringify(result ?? null));
      } catch (err) {
        return text((err as Error).message || `${spec.name} failed`, true);
      }
    });

    return server;
  }
}
