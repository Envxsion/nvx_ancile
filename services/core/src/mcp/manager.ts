/**
 * ------------------------------------------------------------------
 *  Title    |  MCP client manager
 *  Ref      |  DESIGN.md §2 (MCP), §5.2, §12
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Connect to every enabled MCP server (stdio or
 *           |  Streamable HTTP), list its tools into the registry with
 *           |  tiers from annotations and overrides, keep connections
 *           |  healthy, and reconnect with backoff.
 *  How      |  @modelcontextprotocol/sdk v1 client behind this adapter,
 *           |  so a move to SDK v2 is a change here only. Each tool is
 *           |  registered as "<server>__<tool>" with action
 *           |  "mcp.<server>.<tool>" and resource "mcp:<server>/<tool>",
 *           |  so grants and policies can name a server or one tool.
 *           |  A dropped connection unregisters the server's tools and
 *           |  retries at 1 s, 2 s, 4 s … up to a minute.
 *           |  A stdio server gets the SDK's minimal environment (PATH,
 *           |  HOME and the like) plus the secrets it declares, never
 *           |  Core's own environment. A name that had to be cleaned or
 *           |  shortened gets a short hash so two tools never collide.
 *  Note     |  TODO(phase-5): OAuth for remote servers (tokens in the
 *           |  secret store), elicitation → approval UI.
 * ------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from '@nvx/contracts';
import type { z } from 'zod';
import { logFor } from '../obs/logger';
import type { SecretStore } from '../secrets';
import { type ToolRegistry, tierFromMcpAnnotations } from '../tools/registry';

const log = logFor('mcp');

export type McpServerSpec = z.infer<typeof McpServerConfig>;

export interface McpServerHealth {
  server: string;
  transport: 'stdio' | 'http';
  enabled: boolean;
  connected: boolean;
  tools: number;
  lastError: string | null;
  connectedAt: string | null;
}

export type TransportFactory = (spec: McpServerSpec, env: Record<string, string>) => Transport;

export const defaultTransport: TransportFactory = (spec, env) =>
  spec.transport === 'stdio'
    ? new StdioClientTransport({
        command: spec.command,
        args: spec.args,
        env: { ...getDefaultEnvironment(), ...env },
        stderr: 'pipe',
      })
    : new StreamableHTTPClientTransport(new URL(spec.url));

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

interface Live {
  spec: McpServerSpec;
  client: Client | null;
  retry: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  stopped: boolean;
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

export class McpManager {
  private readonly health = new Map<string, McpServerHealth>();
  private readonly live = new Map<string, Live>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly opts: { secrets?: SecretStore; transport?: TransportFactory; version?: string } = {},
  ) {}

  /** Connect every enabled server; failures are recorded, never thrown. */
  async start(servers: McpServerSpec[]): Promise<void> {
    await Promise.all(servers.map((s) => this.connect(s)));
  }

  async connect(spec: McpServerSpec): Promise<McpServerHealth> {
    const prev = this.live.get(spec.name);
    if (prev) await this.disconnect(spec.name);
    const entry: Live = { spec, client: null, retry: null, backoffMs: 1_000, stopped: false };
    this.live.set(spec.name, entry);
    this.setHealth(spec, {
      connected: false,
      tools: 0,
      lastError: spec.enabled ? null : 'Switched off in config/mcp.yaml',
    });
    if (!spec.enabled) return this.status(spec.name);
    await this.attempt(entry);
    return this.status(spec.name);
  }

  private setHealth(spec: McpServerSpec, h: Partial<McpServerHealth>) {
    const prev = this.health.get(spec.name);
    this.health.set(spec.name, {
      server: spec.name,
      transport: spec.transport,
      enabled: spec.enabled,
      connected: false,
      tools: 0,
      lastError: null,
      connectedAt: null,
      ...prev,
      ...h,
    });
  }

  private async env(spec: McpServerSpec): Promise<Record<string, string>> {
    if (spec.transport !== 'stdio' || !this.opts.secrets) return {};
    const out: Record<string, string> = {};
    for (const name of spec.env_secrets) {
      const v = await this.opts.secrets.get(name);
      if (v !== undefined) out[name] = v;
    }
    return out;
  }

  private async attempt(entry: Live): Promise<void> {
    const { spec } = entry;
    const client = new Client({ name: 'nvx-ancile', version: this.opts.version ?? '0.1.0' });
    // disconnect() can land during any await below: then close what was opened and stop.
    const abandoned = async () => {
      if (!entry.stopped) return false;
      await client.close().catch(() => undefined);
      return true;
    };
    try {
      const env = await this.env(spec);
      if (await abandoned()) return;
      const transport = (this.opts.transport ?? defaultTransport)(spec, env);
      transport.onclose = () => {
        if (entry.stopped || entry.client !== client) return;
        log.warn({ server: spec.name }, 'MCP server disconnected; reconnecting');
        this.registry.unregisterSource((s) => s.kind === 'mcp' && s.server === spec.name);
        entry.client = null;
        this.setHealth(spec, { connected: false, tools: 0, lastError: 'The connection closed' });
        this.schedule(entry);
      };
      await client.connect(transport);
      if (await abandoned()) return;
      const { tools } = await client.listTools();
      if (await abandoned()) return;
      entry.client = client;
      entry.backoffMs = 1_000;
      this.registry.unregisterSource((s) => s.kind === 'mcp' && s.server === spec.name);
      const named = new Set<string>();
      for (const t of tools) {
        const name = mcpToolName(
          spec.name,
          t.name,
          (n) => named.has(n) || this.registry.get(n) !== undefined,
        );
        named.add(name);
        const override = spec.tools[t.name];
        const annotations = t.annotations as
          | { readOnlyHint?: boolean; destructiveHint?: boolean }
          | undefined;
        this.registry.register(
          {
            name,
            description: t.description ?? `${t.name} (from ${spec.name})`,
            inputSchema: t.inputSchema,
            action: `mcp.${spec.name}.${t.name}`,
            tier: tierFromMcpAnnotations(annotations),
            destructive: annotations?.destructiveHint === true,
            source: { kind: 'mcp', server: spec.name },
            resource: () => `mcp:${spec.name}/${t.name}`,
            execute: async (args, ctx) => {
              const live = this.live.get(spec.name)?.client;
              if (!live) throw new Error(`${spec.name} is not connected right now`);
              const res = await live.callTool(
                { name: t.name, arguments: (args ?? {}) as Record<string, unknown> },
                undefined,
                { signal: ctx.signal },
              );
              const text = resultText(res.content);
              if (res.isError) throw new Error(text || `${t.name} failed`);
              return res.structuredContent ?? text;
            },
          },
          override,
        );
      }
      this.setHealth(spec, {
        connected: true,
        tools: tools.length,
        lastError: null,
        connectedAt: new Date().toISOString(),
      });
      log.info({ server: spec.name, tools: tools.length }, 'MCP server connected');
    } catch (err) {
      await client.close().catch(() => undefined);
      if (entry.stopped) return;
      const message = (err as Error).message ?? String(err);
      this.setHealth(spec, { connected: false, tools: 0, lastError: message });
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

  async disconnect(name: string): Promise<void> {
    const entry = this.live.get(name);
    if (entry) {
      entry.stopped = true;
      if (entry.retry) clearTimeout(entry.retry);
      const c = entry.client;
      entry.client = null;
      await c?.close().catch(() => undefined);
    }
    this.live.delete(name);
    this.registry.unregisterSource((s) => s.kind === 'mcp' && s.server === name);
    this.health.delete(name);
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

  status(): McpServerHealth[];
  status(name: string): McpServerHealth;
  status(name?: string): McpServerHealth | McpServerHealth[] {
    if (name !== undefined) return this.health.get(name) as McpServerHealth;
    return [...this.health.values()];
  }
}
