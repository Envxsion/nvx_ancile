/**
 * ------------------------------------------------------------------
 *  Title    |  MCP client manager
 *  Ref      |  DESIGN.md §2 (MCP), §5.2, §12 · docs/plugins.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Connect to every enabled MCP server (stdio or
 *           |  Streamable HTTP), list its tools into the registry with
 *           |  tiers from annotations, SDK metadata and overrides, keep
 *           |  connections healthy, and reconnect with backoff.
 *  How      |  @modelcontextprotocol/sdk v1 client behind this adapter,
 *           |  so a move to SDK v2 is a change here only. Each tool is
 *           |  registered as "<server>__<tool>" with action
 *           |  "mcp.<server>.<tool>" and resource "mcp:<server>/<tool>",
 *           |  so grants and policies can name a server or one tool.
 *           |  A dropped connection unregisters the server's tools and
 *           |  retries at 1 s, 2 s, 4 s … up to a minute. The tools a
 *           |  server listed are kept, so a changed override re-registers
 *           |  them without a reconnect; tools/list_changed re-lists.
 *           |  A stdio server gets the SDK's minimal environment (PATH,
 *           |  HOME and the like) plus its own env and secrets, never
 *           |  Core's own environment. An http server gets its headers
 *           |  and secret headers on every request. A name that had to
 *           |  be cleaned or shortened gets a short hash so two tools
 *           |  never collide. Every status change is published as
 *           |  mcp.server_changed. Every list a server gives is shown
 *           |  to the rug-pull guard (guard.ts) before its tools are
 *           |  registered: tools added or changed since you approved
 *           |  the server are held back until you approve the new
 *           |  list, so the model never sees them.
 *  Note     |  TODO(phase-5): OAuth for remote servers (tokens in the
 *           |  secret store), elicitation → approval UI.
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { type McpServerConfig, type McpServerStatus, Tier } from '@nvx/contracts';
import type { z } from 'zod';
import { BUILD_VERSION } from '../build';
import type { EventBus } from '../events/bus';
import { logFor } from '../obs/logger';
import type { SecretStore } from '../secrets';
import { type ToolOverride, type ToolRegistry, tierFromMcpAnnotations } from '../tools/registry';
import type { McpToolGuard } from './guard';

const log = logFor('mcp');

/** Where @nvx/plugin-sdk puts Ancile's own tool metadata (packages/plugin-sdk/src/tool.ts). */
export const ANCILE_META = 'sh.nvx.ancile';

/**
 * A server as the manager runs it: the config/mcp.yaml shape, plus what a
 * server added in the app carries (an id, plain env or headers, and secrets
 * named by the secret store entry that holds each value).
 */
export type McpServerSpec = z.infer<typeof McpServerConfig> & {
  /** What the UI and events call it; config/mcp.yaml servers are `file:<name>`. */
  id?: string;
  /** Plain environment for a stdio server. */
  env?: Record<string, string>;
  /** Plain request headers for an http server. */
  headers?: Record<string, string>;
  /** Env var (stdio) or header (http) → the secret store entry holding its value. */
  secrets?: { key: string; secret: string }[];
};

export interface McpServerHealth {
  server: string;
  id: string;
  transport: 'stdio' | 'http' | 'sse';
  enabled: boolean;
  status: McpServerStatus;
  connected: boolean;
  tools: number;
  lastError: string | null;
  connectedAt: string | null;
}

/** A tool a server offers, before any override. */
export interface McpToolInfo {
  /** Its name on the server. */
  name: string;
  /** The name the model sees (`<server>__<tool>`). */
  id: string;
  description: string;
  /** The description exactly as the server gave it (null when it gave none): what is fingerprinted. */
  rawDescription?: string | null;
  inputSchema: unknown;
  /** From SDK metadata when present, else from the MCP hints; never auto when destructive. */
  defaultTier: Tier;
  destructive: boolean;
  readOnly: boolean;
}

/** Environment (stdio) or request headers (http), resolved with secret values. */
export type TransportFactory = (spec: McpServerSpec, resolved: Record<string, string>) => Transport;

export const defaultTransport: TransportFactory = (spec, resolved) =>
  spec.transport === 'stdio'
    ? new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        env: { ...getDefaultEnvironment(), ...resolved },
        stderr: 'pipe',
      })
    : spec.transport === 'sse'
      ? new SSEClientTransport(new URL(spec.url), { requestInit: { headers: resolved } })
      : new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: resolved } });

const MAX_TOOL_NAME = 64;

/**
 * The name a model sees for an MCP tool: "<server>__<tool>". When that has to
 * be cleaned (characters providers refuse) or shortened, or is already taken,
 * a short hash of the original keeps it unique and stable.
 */
export function mcpToolName(
  server: string,
  tool: string,
  taken: (name: string) => boolean = () => false,
): string {
  const raw = `${server}__${tool}`;
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  if (clean === raw && clean.length <= MAX_TOOL_NAME && !taken(clean)) return clean;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 6);
  return `${clean.slice(0, MAX_TOOL_NAME - hash.length - 1)}_${hash}`;
}

/** The id a server is shown and published under. */
export const serverId = (spec: Pick<McpServerSpec, 'id' | 'name'>) => spec.id ?? `file:${spec.name}`;

/** What applies to one tool after its override: the destructive floor holds even against config. */
export function effectiveTool(t: McpToolInfo, o: ToolOverride | undefined) {
  const destructive = o?.destructive ?? t.destructive;
  let tier = o?.tier ?? t.defaultTier;
  if (destructive && tier === 'auto') tier = 'gated';
  return { tier, destructive, disabled: o?.disabled === true, overridden: o?.tier !== undefined };
}

interface Live {
  spec: McpServerSpec;
  client: Client | null;
  retry: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  stopped: boolean;
  tools: McpToolInfo[];
  /** Tools the guard holds back (added or changed since approval). */
  held: Set<string>;
}

/** Text of an MCP tool result, for the model and the preview. */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((c: { type?: string; text?: string; resource?: { uri?: string } }) =>
      c.type === 'text'
        ? (c.text ?? '')
        : c.type === 'resource'
          ? `[resource ${c.resource?.uri ?? ''}]`
          : `[${c.type ?? 'content'}]`,
    )
    .join('\n');
}

interface ListedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  _meta?: Record<string, unknown>;
}

/** Tier and flags from MCP hints, with @nvx/plugin-sdk metadata winning where present. */
function describeTool(t: ListedTool): Pick<McpToolInfo, 'defaultTier' | 'destructive' | 'readOnly'> {
  const a = t.annotations;
  const metaTier = Tier.safeParse(t._meta?.[`${ANCILE_META}/tier`]);
  const metaDestructive = t._meta?.[`${ANCILE_META}/destructive`];
  const destructive = typeof metaDestructive === 'boolean' ? metaDestructive : a?.destructiveHint === true;
  let defaultTier = metaTier.success ? metaTier.data : tierFromMcpAnnotations(a);
  if (destructive && defaultTier === 'auto') defaultTier = 'gated';
  return { defaultTier, destructive, readOnly: a?.readOnlyHint === true && !destructive };
}

export class McpManager {
  private readonly health = new Map<string, McpServerHealth>();
  private readonly live = new Map<string, Live>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly opts: {
      secrets?: SecretStore;
      transport?: TransportFactory;
      version?: string;
      /** Where mcp.server_changed goes (the global event stream). */
      events?: Pick<EventBus, 'publish'>;
      /** The rug-pull guard: every listed set of tools is checked against the approved one. */
      guard?: McpToolGuard;
    } = {},
  ) {
    // A new list approved: its held tools are registered at once, without a reconnect.
    opts.guard?.onApproved((origin, server) => {
      if (origin !== 'host') return;
      const entry = this.live.get(server);
      if (!entry?.client) return;
      entry.held = opts.guard?.held('host', server) ?? new Set();
      this.registerTools(entry);
      const h = this.health.get(server);
      if (h) this.emit(h);
    });
  }

  /** Connect every enabled server; failures are recorded, never thrown. */
  async start(servers: McpServerSpec[]): Promise<void> {
    await Promise.all(servers.map((s) => this.connect(s)));
  }

  /**
   * Connect (or reconnect with a changed spec). The status is "connecting"
   * (or "disabled") before the first await, so a caller that does not wait
   * still sees it.
   */
  async connect(spec: McpServerSpec): Promise<McpServerHealth> {
    const prev = this.live.get(spec.name);
    const entry: Live = {
      spec,
      client: null,
      retry: null,
      backoffMs: 1_000,
      stopped: false,
      tools: [],
      held: new Set(),
    };
    this.live.set(spec.name, entry);
    this.setHealth(spec, {
      status: spec.enabled ? 'connecting' : 'disabled',
      connected: false,
      tools: 0,
      lastError: spec.enabled ? null : spec.id ? 'Switched off' : 'Switched off in config/mcp.yaml',
      connectedAt: null,
    });
    if (prev) await this.halt(prev);
    if (!spec.enabled || entry.stopped) return this.status(spec.name);
    await this.attempt(entry);
    return this.status(spec.name);
  }

  private setHealth(spec: McpServerSpec, h: Partial<McpServerHealth>, force = false) {
    const prev = this.health.get(spec.name);
    const next: McpServerHealth = {
      server: spec.name,
      id: serverId(spec),
      transport: spec.transport,
      enabled: spec.enabled,
      status: 'connecting',
      connected: false,
      tools: 0,
      lastError: null,
      connectedAt: null,
      ...prev,
      ...h,
    };
    next.id = serverId(spec);
    next.enabled = spec.enabled;
    next.transport = spec.transport;
    this.health.set(spec.name, next);
    if (force || prev?.status !== next.status || prev?.tools !== next.tools || prev?.id !== next.id)
      this.emit(next);
  }

  private emit(
    h: Pick<McpServerHealth, 'id' | 'server' | 'status' | 'tools' | 'lastError'>,
    removed = false,
  ) {
    const bus = this.opts.events;
    if (!bus) return;
    void bus
      .publish({
        type: 'mcp.server_changed',
        server_id: h.id,
        name: h.server,
        status: removed ? 'removed' : h.status,
        tools: removed ? 0 : h.tools,
        ...(!removed && h.lastError && h.status === 'error' && { detail: h.lastError }),
      })
      .catch((err: unknown) => log.warn({ err, server: h.server }, 'could not publish an MCP change'));
  }

  /** Plain env plus secrets (stdio), or headers plus secret headers (http). */
  private async resolved(spec: McpServerSpec): Promise<Record<string, string>> {
    const out: Record<string, string> = { ...(spec.transport === 'stdio' ? spec.env : spec.headers) };
    const store = this.opts.secrets;
    if (!store) return out;
    if (spec.transport === 'stdio')
      for (const name of spec.env_secrets) {
        const v = await store.get(name);
        if (v !== undefined) out[name] = v;
      }
    for (const s of spec.secrets ?? []) {
      const v = await store.get(s.secret);
      if (v !== undefined) out[s.key] = v;
    }
    return out;
  }

  /** Put a server's listed tools into the registry, with the overrides that apply now. */
  private registerTools(entry: Live) {
    const { spec } = entry;
    this.registry.unregisterSource((s) => s.kind === 'mcp' && s.server === spec.name);
    for (const t of entry.tools) {
      // Added or changed since you approved the server: not offered until you approve the new list.
      if (entry.held.has(t.name)) continue;
      this.registry.register(
        {
          name: t.id,
          description: t.description,
          inputSchema: t.inputSchema,
          action: `mcp.${spec.name}.${t.name}`,
          tier: t.defaultTier,
          destructive: t.destructive,
          ...(t.readOnly && { readOnly: true }),
          source: { kind: 'mcp', server: spec.name },
          resource: () => `mcp:${spec.name}/${t.name}`,
          execute: async (args, ctx) => {
            const live = this.live.get(spec.name)?.client;
            if (!live) throw new Error(`${spec.name} is not connected right now`);
            const res = await live.callTool(
              {
                name: t.name,
                arguments: (args ?? {}) as Record<string, unknown>,
                _meta: { [`${ANCILE_META}/idempotency_key`]: ctx.idempotencyKey },
              },
              undefined,
              { signal: ctx.signal },
            );
            const text = resultText(res.content);
            if (res.isError) throw new Error(text || `${t.name} failed`);
            return res.structuredContent ?? text;
          },
        },
        spec.tools[t.name],
      );
    }
  }

  /** Ask the server for its tools and register them. */
  private async loadTools(entry: Live, client: Client): Promise<boolean> {
    const { tools } = await client.listTools();
    if (entry.stopped) return false;
    const { spec } = entry;
    const listed = tools as ListedTool[];
    // Fail closed: a list the guard cannot check is not registered (the error reconnects later).
    const seen = this.opts.guard
      ? await this.opts.guard.observe(
          'host',
          spec.name,
          listed.map((t) => ({
            name: t.name,
            description: t.description ?? null,
            inputSchema: t.inputSchema,
          })),
        )
      : null;
    if (entry.stopped) return false;
    entry.held = seen?.held ?? new Set();
    // Names this server already holds are free to take again.
    const own = new Set(entry.tools.map((t) => t.id));
    const named = new Set<string>();
    entry.tools = listed.map((t) => {
      const id = mcpToolName(
        spec.name,
        t.name,
        (n) => named.has(n) || (!own.has(n) && this.registry.get(n) !== undefined),
      );
      named.add(id);
      return {
        name: t.name,
        id,
        description: t.description ?? `${t.name} (from ${spec.name})`,
        rawDescription: t.description ?? null,
        inputSchema: t.inputSchema,
        ...describeTool(t),
      };
    });
    this.registerTools(entry);
    return true;
  }

  private async attempt(entry: Live): Promise<void> {
    const { spec } = entry;
    const client = new Client({ name: 'nvx-ancile', version: this.opts.version ?? BUILD_VERSION });
    // halt() can land during any await below: then close what was opened and stop.
    const abandoned = async () => {
      if (!entry.stopped) return false;
      await client.close().catch(() => undefined);
      return true;
    };
    try {
      const resolved = await this.resolved(spec);
      if (await abandoned()) return;
      const transport = (this.opts.transport ?? defaultTransport)(spec, resolved);
      transport.onclose = () => {
        if (entry.stopped || entry.client !== client) return;
        log.warn({ server: spec.name }, 'MCP server disconnected; reconnecting');
        this.registry.unregisterSource((s) => s.kind === 'mcp' && s.server === spec.name);
        entry.client = null;
        entry.tools = [];
        this.setHealth(spec, {
          status: 'error',
          connected: false,
          tools: 0,
          lastError: 'The connection closed',
        });
        this.schedule(entry);
      };
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (entry.stopped || entry.client !== client) return;
        try {
          if (!(await this.loadTools(entry, client))) return;
          this.setHealth(spec, { tools: entry.tools.length }, true);
          log.info({ server: spec.name, tools: entry.tools.length }, 'MCP server changed its tools');
        } catch (err) {
          log.warn({ server: spec.name, err: (err as Error).message }, 'could not list the changed tools');
        }
      });
      await client.connect(transport);
      if (await abandoned()) return;
      entry.client = client;
      if (!(await this.loadTools(entry, client))) {
        await abandoned();
        return;
      }
      entry.backoffMs = 1_000;
      this.setHealth(spec, {
        status: 'connected',
        connected: true,
        tools: entry.tools.length,
        lastError: null,
        connectedAt: new Date().toISOString(),
      });
      log.info({ server: spec.name, tools: entry.tools.length }, 'MCP server connected');
    } catch (err) {
      if (entry.client === client) entry.client = null;
      await client.close().catch(() => undefined);
      if (entry.stopped) return;
      const message = (err as Error).message ?? String(err);
      this.setHealth(spec, { status: 'error', connected: false, tools: 0, lastError: message });
      log.warn({ server: spec.name, err: message }, 'MCP server could not connect');
      this.schedule(entry);
    }
  }

  private schedule(entry: Live) {
    if (entry.stopped || entry.retry) return;
    const delay = entry.backoffMs;
    entry.backoffMs = Math.min(entry.backoffMs * 2, 60_000);
    entry.retry = setTimeout(() => {
      entry.retry = null;
      if (!entry.stopped) void this.attempt(entry);
    }, delay);
    entry.retry.unref?.();
  }

  /** Stop one connection and take its tools out of the registry. */
  private async halt(entry: Live): Promise<void> {
    entry.stopped = true;
    if (entry.retry) clearTimeout(entry.retry);
    entry.retry = null;
    const c = entry.client;
    entry.client = null;
    entry.tools = [];
    // Only when no newer connection for the same name holds the tools now.
    const current = this.live.get(entry.spec.name);
    if (!current || current === entry || !current.client)
      this.registry.unregisterSource((s) => s.kind === 'mcp' && s.server === entry.spec.name);
    await c?.close().catch(() => undefined);
  }

  /** Disconnect quietly (shutdown, or before connecting again under another name). */
  async disconnect(name: string): Promise<void> {
    const entry = this.live.get(name);
    this.live.delete(name);
    if (entry) await this.halt(entry);
    this.registry.unregisterSource((s) => s.kind === 'mcp' && s.server === name);
    this.health.delete(name);
  }

  /** Disconnect for good and tell the UI the server is gone. */
  async remove(name: string): Promise<void> {
    const h = this.health.get(name);
    await this.disconnect(name);
    if (h) this.emit(h, true);
  }

  async stop(): Promise<void> {
    await Promise.all([...this.live.keys()].map((n) => this.disconnect(n)));
  }

  /** Reconnect now (Settings → Tools → Test). */
  async test(name: string): Promise<McpServerHealth | undefined> {
    const entry = this.live.get(name);
    if (!entry) return undefined;
    return this.connect(entry.spec);
  }

  /**
   * Change a server's per-tool overrides and re-register its tools at once,
   * without a reconnect.
   */
  setOverrides(name: string, tools: Record<string, ToolOverride>): boolean {
    const entry = this.live.get(name);
    if (!entry) return false;
    entry.spec = { ...entry.spec, tools } as McpServerSpec;
    if (entry.client) {
      this.registerTools(entry);
      const h = this.health.get(name);
      if (h) this.emit(h);
    }
    return true;
  }

  /** The tools a connected server offers, before overrides. */
  toolsOf(name: string): McpToolInfo[] {
    return this.live.get(name)?.tools ?? [];
  }

  /** Tools held back until the server's changed list is approved. */
  heldOf(name: string): Set<string> {
    return this.live.get(name)?.held ?? new Set();
  }

  /** The spec the manager runs for a name, with the overrides that apply now. */
  specOf(name: string): McpServerSpec | undefined {
    return this.live.get(name)?.spec;
  }

  status(): McpServerHealth[];
  status(name: string): McpServerHealth;
  status(name?: string): McpServerHealth | McpServerHealth[] {
    if (name !== undefined) return this.health.get(name) as McpServerHealth;
    return [...this.health.values()];
  }
}
