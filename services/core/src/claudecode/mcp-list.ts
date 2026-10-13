/**
 * ------------------------------------------------------------------
 *  Title    |  Claude Code's own MCP servers, listed read-only
 *  Ref      |  docs/claude-code.md (MCP servers) · docs/plugins.md
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Admin → Plugins shows the MCP servers you already have
 *           |  in Claude Code (claude.ai connectors, your user and
 *           |  project config, plugins), with where each is set up and
 *           |  whether it is connected. They are managed in Claude Code
 *           |  and used by Claude Code threads; NVX Ancile never
 *           |  changes them.
 *  How      |  Three sources, best first. (1) Claude Code's own status
 *           |  report (the SDK's mcpServerStatus, the bridge's
 *           |  `mcp_status` op), asked from a session that sends nothing
 *           |  and writes no transcript: on first view, when the list
 *           |  is old, or on Refresh (rate-limited). (2) Every live
 *           |  session's `system/init` message, which names its servers
 *           |  and their status: a status is updated or a server added,
 *           |  never removed (a lean session loads fewer). (3) With
 *           |  neither, only the server NAMES in Claude Code's config:
 *           |  ~/.claude.json's mcpServers (user), its per-folder
 *           |  entries (local) and .mcp.json in the folders NVX Ancile
 *           |  knows (project). Nothing is ever written to them.
 *  Note     |  Only a name, where it is set up, a status and a tool
 *           |  count leave this file: never a command, an address, an
 *           |  environment value, a header or a token. NVX Ancile's own
 *           |  server in a session ("ancile") is not listed.
 * ------------------------------------------------------------------
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeCodeMcpServer, ClaudeCodeMcpServers, ClaudeCodeMcpSource } from '@nvx/contracts';
import type { EventBus } from '../events/bus';
import { logFor } from '../obs/logger';
import type { SettingsStore } from '../settings';
import type { LiveBridge, LiveEvent } from './bridge-protocol';
import { ANCILE_MCP_SERVER } from './permission-map';

const log = logFor('claude-code-mcp');

export const MCP_LIST_KEY = 'claude_code.mcp_servers';
/** The list is asked again on view when it is older than this. */
export const MCP_LIST_MAX_AGE_MS = 10 * 60_000;
/** Even Refresh waits this long after the last ask. */
export const MCP_LIST_FORCE_INTERVAL_MS = 20_000;
/** Opening the list with nothing known waits this long for Claude Code's answer. */
export const MCP_FIRST_ASK_WAIT_MS = 15_000;
/** Claude Code config files larger than this are not read. */
const MAX_CONFIG_BYTES = 5 * 1024 * 1024;
const MAX_SERVERS = 200;

const STATUSES = new Set(['connected', 'failed', 'needs-auth', 'pending', 'disabled']);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nameOk = (n: unknown): n is string =>
  typeof n === 'string' && n.trim().length > 0 && n.length <= 120 && n !== ANCILE_MCP_SERVER;

type Stored = Omit<ClaudeCodeMcpServers, 'can_refresh'>;
const EMPTY: Stored = { servers: [], from: null, updated_at: null };

/** Where a server is set up, from Claude Code's `source` (newer) or `scope`. */
export function sourceOf(source: unknown, scope: unknown, name?: string): ClaudeCodeMcpSource {
  const s = typeof source === 'string' ? source : typeof scope === 'string' ? scope : '';
  if (s === 'claudeai') return 'claudeai';
  if (s === 'user' || s === 'project' || s === 'local' || s === 'plugin') return s;
  // Older Claude Code: no source; a plugin's server is still named "plugin:…".
  if (name?.startsWith('plugin:')) return 'plugin';
  if (name?.startsWith('claude.ai ')) return 'claudeai';
  return 'other';
}

const ORDER: ClaudeCodeMcpSource[] = ['claudeai', 'user', 'project', 'local', 'plugin', 'other'];
const STATUS_ORDER = ['connected', 'needs-auth', 'pending', 'failed', 'disabled'];
export function sortServers(list: ClaudeCodeMcpServer[]): ClaudeCodeMcpServer[] {
  return [...list].sort(
    (a, b) =>
      ORDER.indexOf(a.source) - ORDER.indexOf(b.source) ||
      (a.status ? STATUS_ORDER.indexOf(a.status) : 9) - (b.status ? STATUS_ORDER.indexOf(b.status) : 9) ||
      a.name.localeCompare(b.name),
  );
}

/** Claude Code's status report, read loosely: name, where, status and a tool count only. */
export function serversFromStatus(list: unknown): ClaudeCodeMcpServer[] {
  if (!Array.isArray(list)) return [];
  const out: ClaudeCodeMcpServer[] = [];
  for (const s of list.slice(0, MAX_SERVERS)) {
    if (!isObj(s) || !nameOk(s.name) || out.some((x) => x.name === s.name)) continue;
    out.push({
      name: s.name,
      source: sourceOf(s.source, s.scope, s.name),
      status:
        typeof s.status === 'string' && STATUSES.has(s.status)
          ? (s.status as ClaudeCodeMcpServer['status'])
          : null,
      tools: Array.isArray(s.tools) ? s.tools.length : null,
    });
  }
  return sortServers(out);
}

/** A session's init message's servers, or null when it is not one. */
export function serversFromInit(m: Record<string, unknown>): ClaudeCodeMcpServer[] | null {
  if (m.type !== 'system' || m.subtype !== 'init' || !Array.isArray(m.mcp_servers)) return null;
  const tools = new Map<string, number>();
  if (Array.isArray(m.tools))
    for (const t of m.tools) {
      const x = typeof t === 'string' ? /^mcp__(.+?)__/.exec(t) : null;
      if (x?.[1]) tools.set(x[1], (tools.get(x[1]) ?? 0) + 1);
    }
  const out = serversFromStatus(m.mcp_servers);
  // Tool names carry a normalised server name; a count is kept only where it matches.
  return out.map((s) => ({
    ...s,
    tools: s.status === 'connected' ? (tools.get(s.name) ?? s.tools) : s.tools,
  }));
}

/** Names only, from a parsed config object's mcpServers. */
function namesIn(v: unknown, source: ClaudeCodeMcpSource): ClaudeCodeMcpServer[] {
  if (!isObj(v)) return [];
  return Object.keys(v)
    .filter(nameOk)
    .slice(0, MAX_SERVERS)
    .map((name) => ({ name, source, status: null, tools: null }));
}

async function readJson(path: string): Promise<unknown> {
  try {
    const buf = await readFile(path);
    if (buf.byteLength > MAX_CONFIG_BYTES) return null;
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

const samePath = (a: string, b: string) =>
  a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
  b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * Server names from Claude Code's config: ~/.claude.json (mcpServers for
 * user scope, projects[folder].mcpServers for local scope in the folders
 * given) and <folder>/.mcp.json (project scope). Only the keys are read
 * out; every value (command, address, env, headers) is left where it is.
 */
export async function serversFromConfig(home: string, folders: string[]): Promise<ClaudeCodeMcpServer[]> {
  const out: ClaudeCodeMcpServer[] = [];
  const add = (list: ClaudeCodeMcpServer[]) => {
    for (const s of list) if (!out.some((x) => x.name === s.name)) out.push(s);
  };
  const user = await readJson(join(home, '.claude.json'));
  if (isObj(user)) {
    add(namesIn(user.mcpServers, 'user'));
    if (isObj(user.projects))
      for (const [path, p] of Object.entries(user.projects))
        if (isObj(p) && folders.some((f) => samePath(f, path))) add(namesIn(p.mcpServers, 'local'));
  }
  for (const f of folders.slice(0, 50)) {
    const project = await readJson(join(f, '.mcp.json'));
    if (isObj(project)) add(namesIn(project.mcpServers, 'project'));
  }
  return sortServers(out);
}

export interface McpListDeps {
  settings: SettingsStore;
  bridge: LiveBridge;
  cli(): Promise<{ path: string }>;
  env(): Promise<Record<string, string>>;
  /** Folders NVX Ancile knows Claude Code works in (for project and local config). */
  folders(): Promise<string[]>;
  /** Handles whose sessions load no settings of yours (Claude Code as a model): their init says nothing. */
  ignoreHandle?(handle: string): boolean;
  home?: string;
  bus?: EventBus;
  now?: () => number;
}

export class ClaudeCodeMcpList {
  private cache: Stored | null = null;
  private lastAsk = 0;
  private asking: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: McpListDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Follow live sessions' init messages; returns the unsubscribe. */
  watch(): () => void {
    return this.deps.bridge.onEvent((e: LiveEvent) => {
      if (e.event !== 'session.message' || this.deps.ignoreHandle?.(e.data.handle)) return;
      const found = serversFromInit(e.data.message);
      if (found?.length) void this.mergeInit(found).catch(() => undefined);
    });
  }

  private async load(): Promise<Stored> {
    if (this.cache) return this.cache;
    const v = await this.deps.settings.get<Stored>(MCP_LIST_KEY).catch(() => undefined);
    this.cache = isObj(v) && Array.isArray(v.servers) ? { ...EMPTY, ...v } : { ...EMPTY };
    return this.cache;
  }

  private async save(next: Stored): Promise<void> {
    this.cache = next;
    await this.deps.settings
      .set(MCP_LIST_KEY, next)
      .catch((err: unknown) => log.warn({ err: (err as Error).message }, 'Claude Code MCP list not saved'));
    await this.deps.bus?.publish({ type: 'claude_code.changed', what: 'mcp' }).catch(() => undefined);
  }

  /** An init message updates statuses and adds servers; it never removes one (a lean session loads fewer). */
  async mergeInit(found: ClaudeCodeMcpServer[]): Promise<void> {
    const cur = await this.load();
    const by = new Map(cur.servers.map((s) => [s.name, s]));
    for (const s of found) {
      const old = by.get(s.name);
      by.set(s.name, old ? { ...old, status: s.status ?? old.status, tools: s.tools ?? old.tools } : s);
    }
    await this.save({
      servers: sortServers([...by.values()]),
      from: 'status',
      updated_at: new Date(this.now()).toISOString(),
    });
  }

  async get(opts: { refresh?: boolean } = {}): Promise<ClaudeCodeMcpServers> {
    const canRefresh = await this.deps.cli().then(
      () => true,
      () => false,
    );
    const cur = await this.load();
    const age = cur.updated_at ? this.now() - Date.parse(cur.updated_at) : Number.POSITIVE_INFINITY;
    const gap = this.now() - this.lastAsk;
    const due = opts.refresh
      ? gap >= MCP_LIST_FORCE_INTERVAL_MS
      : (cur.from !== 'status' || age >= MCP_LIST_MAX_AGE_MS) && gap >= MCP_LIST_MAX_AGE_MS;
    if (canRefresh && due) {
      const asking = this.ask().catch(() => undefined);
      if (opts.refresh || cur.from !== 'status')
        await Promise.race([asking, new Promise((r) => setTimeout(r, MCP_FIRST_ASK_WAIT_MS).unref?.())]);
    }
    const now = await this.load();
    if (now.from === 'status' || now.servers.length) return { ...now, can_refresh: canRefresh };
    // Claude Code could not be asked: the names in its config, at least.
    const servers = await serversFromConfig(
      this.deps.home ?? homedir(),
      await this.deps.folders().catch(() => []),
    ).catch(() => []);
    return { servers, from: servers.length ? 'config' : null, updated_at: null, can_refresh: canRefresh };
  }

  private ask(): Promise<void> {
    this.asking ??= this.askNow().finally(() => {
      this.asking = null;
    });
    return this.asking;
  }

  private async askNow(): Promise<void> {
    this.lastAsk = this.now();
    const cli = await this.deps.cli();
    const { handle } = await this.deps.bridge.open({
      cwd: this.deps.home ?? homedir(),
      path_to_cli: cli.path,
      persist: false,
      permission_mode: 'default',
      env: await this.deps.env(),
    });
    try {
      const list = await this.deps.bridge.control<unknown>(handle, 'mcp_status');
      if (!Array.isArray(list)) return;
      await this.save({
        servers: serversFromStatus(list),
        from: 'status',
        updated_at: new Date(this.now()).toISOString(),
      });
    } catch (err) {
      log.info({ err: (err as Error).message }, 'Claude Code did not list its MCP servers');
    } finally {
      await this.deps.bridge.close(handle).catch(() => undefined);
    }
  }
}
