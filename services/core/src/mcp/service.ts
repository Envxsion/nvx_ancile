/**
 * ------------------------------------------------------------------
 *  Title    |  MCP servers people manage
 *  Ref      |  docs/plugins.md · packages/contracts/src/mcp.ts
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Add, change and remove MCP servers from the app, with
 *           |  secrets kept encrypted and per-tool overrides, and apply
 *           |  every change at once: no restart.
 *  How      |  Two sources. Servers in config/mcp.yaml (source "file",
 *           |  id `file:<name>`) are read-only here except for their
 *           |  tools, whose overrides go to the settings key
 *           |  mcp.file_overrides. Servers added in the app (source
 *           |  "app") live in core.mcp_servers; each secret value is in
 *           |  the secret store as mcp.<id>.<key>. A name in the file
 *           |  wins over an app server with the same name. The manager
 *           |  does the connecting; this decides what it runs.
 *  Note     |  The old settings key mcp.added (the GitHub preset) is
 *           |  moved into core.mcp_servers once, at start.
 * ------------------------------------------------------------------
 */

import {
  AncileError,
  type CreateMcpServerRequest,
  type McpServerView,
  type McpToolView,
  type UpdateMcpServerRequest,
  type UpdateMcpToolRequest,
} from '@nvx/contracts';
import { ulid } from 'ulid';
import { badRequest } from '../obs/errors';
import { logFor } from '../obs/logger';
import type { SecretStore } from '../secrets';
import type { SettingsStore } from '../settings';
import type { ToolOverride } from '../tools/registry';
import { effectiveTool, type McpManager, type McpServerHealth, type McpServerSpec } from './manager';
import type { McpServerRow, McpServerStore } from './store';

const log = logFor('mcp');

/** Servers the GitHub preset saved before core.mcp_servers was used. */
export const MCP_ADDED_SETTING = 'mcp.added';
/** { [file server name]: { [tool]: { tier?, disabled? } } } set in the app for config/mcp.yaml servers. */
export const MCP_FILE_OVERRIDES_SETTING = 'mcp.file_overrides';

/** Where one secret value of an app server is kept. */
export const mcpSecretName = (serverId: string, key: string) => `mcp.${serverId}.${key}`;

const FILE_PREFIX = 'file:';
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_KEY = /^[A-Za-z0-9-]{1,128}$/;

type Overrides = Record<string, ToolOverride>;

/* ---- Errors (docs/errors.md) -------------------------------------------- */

const notFound = () =>
  new AncileError({
    code: 'mcp.not_found',
    title: 'That MCP server was not found',
    hint: 'It may have been removed. Refresh the list in Admin → Plugins.',
    status: 404,
    errorClass: 'permanent',
  });

const toolNotFound = (server: string, tool: string) =>
  new AncileError({
    code: 'mcp.tool_not_found',
    title: `${server} does not offer a tool called ${tool}`,
    hint: 'Its tools are listed once it is connected. Press Test to reconnect, then try again.',
    status: 404,
    errorClass: 'permanent',
  });

const nameTaken = (name: string, inFile: boolean) =>
  new AncileError({
    code: 'mcp.name_taken',
    title: inFile
      ? `config/mcp.yaml already has a server called ${name}`
      : `There is already an MCP server called ${name}`,
    hint: inFile
      ? 'Pick another name. The server in config/mcp.yaml is the one NVX Ancile uses.'
      : 'Pick another name, or edit the server you have.',
    status: 409,
    errorClass: 'permanent',
  });

const readOnly = (name: string) =>
  new AncileError({
    code: 'mcp.read_only',
    title: `${name} comes from config/mcp.yaml`,
    hint: 'Edit or remove it in config/mcp.yaml, then restart NVX Ancile. You can still change its tools here.',
    status: 409,
    errorClass: 'permanent',
  });

const secretMissing = (key: string) =>
  new AncileError({
    code: 'mcp.secret_missing',
    title: `No value is stored for ${key}`,
    hint: `Type the value for ${key}, or take it out of the list.`,
    status: 400,
    errorClass: 'permanent',
  });

const tierNotAllowed = (tool: string) =>
  new AncileError({
    code: 'mcp.tier_not_allowed',
    title: `${tool} can delete or change things, so it always asks first`,
    hint: 'Choose Gated or Critical for this tool.',
    status: 400,
    errorClass: 'permanent',
  });

const transportMismatch = (field: string, transport: 'stdio' | 'http') =>
  new AncileError({
    code: 'mcp.transport_mismatch',
    title: `A ${transport === 'stdio' ? 'command (stdio)' : 'web address (http)'} server has no ${field}`,
    hint: 'The way a server connects cannot change. Remove it and add it again.',
    status: 400,
    errorClass: 'permanent',
  });

/* ---- The service -------------------------------------------------------- */

export interface McpServiceDeps {
  store: McpServerStore;
  secrets: SecretStore;
  settings: SettingsStore;
  manager: McpManager;
  /** config/mcp.yaml servers. */
  files: McpServerSpec[];
}

type Resolved = { kind: 'file'; spec: McpServerSpec } | { kind: 'app'; row: McpServerRow };

export class McpService {
  constructor(private readonly deps: McpServiceDeps) {}

  private get m() {
    return this.deps.manager;
  }

  private fileNamed(name: string) {
    return this.deps.files.find((f) => f.name === name);
  }

  private async fileOverrides(): Promise<Record<string, Overrides>> {
    return (await this.deps.settings.get<Record<string, Overrides>>(MCP_FILE_OVERRIDES_SETTING)) ?? {};
  }

  /** A file server's YAML overrides with the ones set in the app on top. */
  private fileSpec(f: McpServerSpec, extra: Overrides | undefined): McpServerSpec {
    const tools: Overrides = { ...f.tools };
    for (const [t, o] of Object.entries(extra ?? {})) tools[t] = { ...tools[t], ...o };
    return { ...f, id: `${FILE_PREFIX}${f.name}`, tools } as McpServerSpec;
  }

  private appSpec(row: McpServerRow): McpServerSpec {
    const secrets = row.secret_keys.map((key) => ({ key, secret: mcpSecretName(row.id, key) }));
    const common = { id: row.id, name: row.name, enabled: row.enabled, tools: row.tool_overrides, secrets };
    return row.transport === 'stdio'
      ? {
          ...common,
          transport: 'stdio',
          command: row.command ?? '',
          args: row.args,
          env_secrets: [],
          env: row.env,
        }
      : { ...common, transport: 'http', url: row.url ?? '', oauth: false, headers: row.headers };
  }

  /** Everything the manager should run now. */
  private async specs(): Promise<McpServerSpec[]> {
    const extra = await this.fileOverrides();
    const files = this.deps.files.map((f) => this.fileSpec(f, extra[f.name]));
    const apps = (await this.deps.store.list())
      .filter((r) => !this.fileNamed(r.name))
      .map((r) => this.appSpec(r));
    return [...files, ...apps];
  }

  /** Move the GitHub preset's old settings entries into core.mcp_servers, once. */
  async migrateLegacy(): Promise<void> {
    const old = (await this.deps.settings.get<McpServerSpec[]>(MCP_ADDED_SETTING)) ?? [];
    if (!Array.isArray(old) || old.length === 0) return;
    for (const s of old) {
      if (!s || typeof s.name !== 'string' || (await this.deps.store.byName(s.name))) continue;
      const id = `mcp_${ulid()}`;
      const keys = s.transport === 'stdio' ? (s.env_secrets ?? []) : [];
      for (const key of keys) {
        const v = await this.deps.secrets.get(key);
        if (v !== undefined) await this.deps.secrets.set(mcpSecretName(id, key), v);
      }
      await this.deps.store.create({
        id,
        name: s.name,
        transport: s.transport,
        command: s.transport === 'stdio' ? s.command : null,
        args: s.transport === 'stdio' ? (s.args ?? []) : [],
        env: {},
        url: s.transport === 'http' ? s.url : null,
        headers: {},
        secret_keys: keys,
        enabled: s.enabled !== false,
        tool_overrides: s.tools ?? {},
      });
      log.info({ server: s.name }, 'moved an MCP server from settings into the server list');
    }
    await this.deps.settings.set(MCP_ADDED_SETTING, []);
  }

  /** Move old entries, then connect everything (failures are recorded, never thrown). */
  async start(): Promise<void> {
    await this.migrateLegacy();
    await this.m.start(await this.specs());
  }

  private async resolve(id: string): Promise<Resolved> {
    if (id.startsWith(FILE_PREFIX)) {
      const spec = this.fileNamed(id.slice(FILE_PREFIX.length));
      if (spec) return { kind: 'file', spec };
      throw notFound();
    }
    const row = await this.deps.store.get(id);
    if (row) return { kind: 'app', row };
    // The Cockpit used to address servers by name (Test); still accepted.
    const file = this.fileNamed(id);
    if (file) return { kind: 'file', spec: file };
    const named = await this.deps.store.byName(id);
    if (named) return { kind: 'app', row: named };
    throw notFound();
  }

  /* ---- Views ---- */

  private toolsView(name: string): McpToolView[] {
    const overrides = this.m.specOf(name)?.tools ?? {};
    return this.m.toolsOf(name).map((t) => {
      const e = effectiveTool(t, overrides[t.name]);
      return {
        name: t.name,
        id: t.id,
        description: t.description,
        tier: e.tier,
        default_tier: t.defaultTier,
        overridden: e.overridden,
        disabled: e.disabled,
        destructive: e.destructive,
        read_only: t.readOnly,
      };
    });
  }

  private live(name: string, enabled: boolean, shadowed: boolean) {
    if (shadowed)
      return {
        status: 'error' as const,
        last_error: 'config/mcp.yaml has a server with the same name, and that one is used.',
        connected_at: null,
      };
    const h: McpServerHealth | undefined = this.m.status(name);
    if (!h)
      return {
        status: enabled ? ('connecting' as const) : ('disabled' as const),
        last_error: null,
        connected_at: null,
      };
    return {
      status: h.status,
      last_error: h.status === 'error' ? h.lastError : null,
      connected_at: h.connectedAt,
    };
  }

  private fileView(f: McpServerSpec, saved: Set<string>): McpServerView {
    return {
      id: `${FILE_PREFIX}${f.name}`,
      name: f.name,
      transport: f.transport,
      source: 'file',
      enabled: f.enabled,
      command: f.transport === 'stdio' ? f.command : null,
      args: f.transport === 'stdio' ? f.args : [],
      env: {},
      url: f.transport === 'http' ? f.url : null,
      headers: {},
      secrets: f.transport === 'stdio' ? f.env_secrets.map((key) => ({ key, set: saved.has(key) })) : [],
      ...this.live(f.name, f.enabled, false),
      tools: this.toolsView(f.name),
    };
  }

  private appView(r: McpServerRow, saved: Set<string>): McpServerView {
    const shadowed = !!this.fileNamed(r.name);
    return {
      id: r.id,
      name: r.name,
      transport: r.transport,
      source: 'app',
      enabled: r.enabled,
      command: r.command,
      args: r.args,
      env: r.env,
      url: r.url,
      headers: r.headers,
      secrets: r.secret_keys.map((key) => ({ key, set: saved.has(mcpSecretName(r.id, key)) })),
      ...this.live(r.name, r.enabled, shadowed),
      tools: shadowed ? [] : this.toolsView(r.name),
    };
  }

  private async saved() {
    return new Set(await this.deps.secrets.names());
  }

  async list(): Promise<McpServerView[]> {
    const saved = await this.saved();
    const rows = await this.deps.store.list();
    return [
      ...this.deps.files.map((f) => this.fileView(f, saved)),
      ...rows.map((r) => this.appView(r, saved)),
    ];
  }

  async view(id: string): Promise<McpServerView> {
    const r = await this.resolve(id);
    const saved = await this.saved();
    return r.kind === 'file' ? this.fileView(r.spec, saved) : this.appView(r.row, saved);
  }

  /* ---- Changes ---- */

  private async assertNameFree(name: string, exceptId?: string) {
    if (this.fileNamed(name)) throw nameTaken(name, true);
    const other = await this.deps.store.byName(name);
    if (other && other.id !== exceptId) throw nameTaken(name, false);
  }

  private static checkKeys(keys: string[], transport: 'stdio' | 'http') {
    const re = transport === 'stdio' ? ENV_KEY : HEADER_KEY;
    const seen = new Set<string>();
    for (const k of keys) {
      if (!re.test(k))
        throw badRequest(
          `secrets: ${k} is not a valid ${transport === 'stdio' ? 'environment variable' : 'header'} name`,
        );
      const norm = transport === 'http' ? k.toLowerCase() : k;
      if (seen.has(norm)) throw badRequest(`secrets: ${k} is listed twice`);
      seen.add(norm);
    }
  }

  async create(req: CreateMcpServerRequest): Promise<McpServerView> {
    await this.assertNameFree(req.name);
    McpService.checkKeys(
      req.secrets.map((s) => s.key),
      req.transport,
    );
    for (const s of req.secrets) if (!s.value) throw secretMissing(s.key);
    const id = `mcp_${ulid()}`;
    for (const s of req.secrets) await this.deps.secrets.set(mcpSecretName(id, s.key), s.value as string);
    const ok = await this.deps.store.create({
      id,
      name: req.name,
      transport: req.transport,
      command: req.transport === 'stdio' ? req.command : null,
      args: req.transport === 'stdio' ? req.args : [],
      env: req.transport === 'stdio' ? req.env : {},
      url: req.transport === 'http' ? req.url : null,
      headers: req.transport === 'http' ? req.headers : {},
      secret_keys: req.secrets.map((s) => s.key),
      enabled: req.enabled,
      tool_overrides: {},
    });
    if (!ok) {
      for (const s of req.secrets) await this.deps.secrets.delete(mcpSecretName(id, s.key));
      throw nameTaken(req.name, false);
    }
    const row = (await this.deps.store.get(id)) as McpServerRow;
    // In the background: the view says "connecting" until it has an answer.
    void this.m.connect(this.appSpec(row));
    log.info({ server: row.name, id, transport: row.transport }, 'MCP server added');
    return this.view(id);
  }

  async update(id: string, req: UpdateMcpServerRequest): Promise<McpServerView> {
    const r = await this.resolve(id);
    if (r.kind === 'file') throw readOnly(r.spec.name);
    const row = r.row;
    const wrong =
      row.transport === 'stdio'
        ? (['url', 'headers'] as const).find((k) => req[k] !== undefined)
        : (['command', 'args', 'env'] as const).find((k) => req[k] !== undefined);
    if (wrong) throw transportMismatch(wrong, row.transport);
    if (req.name !== undefined && req.name !== row.name) await this.assertNameFree(req.name, row.id);

    // Secrets: the whole list. Check everything before writing anything.
    let keys = row.secret_keys;
    let secretsChanged = false;
    if (req.secrets) {
      McpService.checkKeys(
        req.secrets.map((s) => s.key),
        row.transport,
      );
      const saved = await this.saved();
      for (const s of req.secrets)
        if (!s.value && !(row.secret_keys.includes(s.key) && saved.has(mcpSecretName(row.id, s.key))))
          throw secretMissing(s.key);
      for (const s of req.secrets)
        if (s.value) {
          await this.deps.secrets.set(mcpSecretName(row.id, s.key), s.value);
          secretsChanged = true;
        }
      keys = req.secrets.map((s) => s.key);
      for (const k of row.secret_keys)
        if (!keys.includes(k)) {
          await this.deps.secrets.delete(mcpSecretName(row.id, k));
          secretsChanged = true;
        }
      if (keys.length !== row.secret_keys.length) secretsChanged = true;
    }

    const updated = await this.deps.store.update(row.id, {
      ...(req.name !== undefined && { name: req.name }),
      ...(req.enabled !== undefined && { enabled: req.enabled }),
      ...(req.command !== undefined && { command: req.command }),
      ...(req.args !== undefined && { args: req.args }),
      ...(req.env !== undefined && { env: req.env }),
      ...(req.url !== undefined && { url: req.url }),
      ...(req.headers !== undefined && { headers: req.headers }),
      secret_keys: keys,
    });
    if (updated === false) throw nameTaken(req.name ?? row.name, false);
    if (!updated) throw notFound();

    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const reconnect =
      secretsChanged ||
      updated.name !== row.name ||
      updated.enabled !== row.enabled ||
      updated.command !== row.command ||
      updated.url !== row.url ||
      !same(updated.args, row.args) ||
      !same(updated.env, row.env) ||
      !same(updated.headers, row.headers);
    if (reconnect) {
      if (updated.name !== row.name) await this.m.disconnect(row.name);
      void this.m.connect(this.appSpec(updated));
      log.info({ server: updated.name, id: row.id }, 'MCP server changed; reconnecting');
    }
    return this.view(row.id);
  }

  async remove(id: string): Promise<void> {
    const r = await this.resolve(id);
    if (r.kind === 'file') throw readOnly(r.spec.name);
    const row = r.row;
    if (!this.fileNamed(row.name)) await this.m.remove(row.name);
    for (const k of row.secret_keys) await this.deps.secrets.delete(mcpSecretName(row.id, k));
    await this.deps.store.remove(row.id);
    log.info({ server: row.name, id: row.id }, 'MCP server removed');
  }

  /** Reconnect now and answer with what happened. */
  async test(id: string): Promise<McpServerView> {
    const r = await this.resolve(id);
    const name = r.kind === 'file' ? r.spec.name : r.row.name;
    if (r.kind === 'app' && this.fileNamed(name)) return this.view(r.row.id);
    if (!(await this.m.test(name))) {
      const extra = await this.fileOverrides();
      await this.m.connect(r.kind === 'file' ? this.fileSpec(r.spec, extra[name]) : this.appSpec(r.row));
    }
    return this.view(r.kind === 'file' ? `${FILE_PREFIX}${name}` : r.row.id);
  }

  async updateTool(id: string, tool: string, req: UpdateMcpToolRequest): Promise<McpServerView> {
    const r = await this.resolve(id);
    const name = r.kind === 'file' ? r.spec.name : r.row.name;
    const info = this.m.toolsOf(name).find((t) => t.name === tool);
    if (!info) throw toolNotFound(name, tool);
    const base = r.kind === 'file' ? r.spec.tools[tool] : undefined;
    const all = r.kind === 'file' ? await this.fileOverrides() : { [name]: r.row.tool_overrides };
    const mine: Overrides = { ...(all[name] ?? {}) };
    const next: ToolOverride = { ...mine[tool] };
    if (req.tier === null) delete next.tier;
    else if (req.tier !== undefined) next.tier = req.tier;
    if (req.disabled === true) next.disabled = true;
    else if (req.disabled === false) {
      if (base?.disabled) next.disabled = false;
      else delete next.disabled;
    }
    const destructive = next.destructive ?? base?.destructive ?? info.destructive;
    if (req.tier === 'auto' && destructive) throw tierNotAllowed(tool);
    if (Object.keys(next).length) mine[tool] = next;
    else delete mine[tool];

    let merged: Overrides;
    if (r.kind === 'file') {
      await this.deps.settings.set(MCP_FILE_OVERRIDES_SETTING, { ...all, [name]: mine });
      merged = this.fileSpec(r.spec, mine).tools;
    } else {
      await this.deps.store.update(r.row.id, { tool_overrides: mine });
      merged = mine;
    }
    this.m.setOverrides(name, merged);
    log.info({ server: name, tool, override: next }, 'MCP tool setting changed');
    return this.view(r.kind === 'file' ? `${FILE_PREFIX}${name}` : r.row.id);
  }

  /**
   * Add or replace a server the app sets up for you (the GitHub preset),
   * then wait for the first connection attempt.
   */
  async savePreset(p: {
    name: string;
    command: string;
    args: string[];
    secrets: { key: string; value: string }[];
  }): Promise<{ view: McpServerView; health: McpServerHealth }> {
    if (this.fileNamed(p.name)) throw nameTaken(p.name, true);
    const existing = await this.deps.store.byName(p.name);
    let row: McpServerRow;
    if (existing) {
      for (const s of p.secrets) await this.deps.secrets.set(mcpSecretName(existing.id, s.key), s.value);
      const keys = [...new Set([...existing.secret_keys, ...p.secrets.map((s) => s.key)])];
      row = (await this.deps.store.update(existing.id, {
        command: p.command,
        args: p.args,
        secret_keys: keys,
        enabled: true,
      })) as McpServerRow;
    } else {
      const id = `mcp_${ulid()}`;
      for (const s of p.secrets) await this.deps.secrets.set(mcpSecretName(id, s.key), s.value);
      await this.deps.store.create({
        id,
        name: p.name,
        transport: 'stdio',
        command: p.command,
        args: p.args,
        env: {},
        url: null,
        headers: {},
        secret_keys: p.secrets.map((s) => s.key),
        enabled: true,
        tool_overrides: {},
      });
      row = (await this.deps.store.get(id)) as McpServerRow;
    }
    const health = await this.m.connect(this.appSpec(row));
    return { view: await this.view(row.id), health };
  }
}
