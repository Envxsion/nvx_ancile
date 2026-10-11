/**
 * MCP servers managed from the app: add, change, test and remove through
 * the API, with secrets that never come back, per-tool settings, servers
 * from config/mcp.yaml read-only, and every change applied at once (tools
 * appear and disappear in GET /tools without a restart). Real SDK servers
 * over the in-memory transport.
 */

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServerView } from '@nvx/contracts';
import { defineTool, toMcpRegistration } from '@nvx/plugin-sdk';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AppEnv } from '../../src/app';
import type { EventBus, GlobalEventInput } from '../../src/events/bus';
import { defaultTransport, McpManager, type McpServerSpec } from '../../src/mcp/manager';
import { toolRoutes } from '../../src/mcp/routes';
import {
  MCP_ADDED_SETTING,
  MCP_FILE_OVERRIDES_SETTING,
  McpService,
  mcpSecretName,
} from '../../src/mcp/service';
import { MemoryMcpServerStore } from '../../src/mcp/store';
import { errorHandler } from '../../src/obs/errors';
import { MemorySecretStore, SecretBox } from '../../src/secrets';
import { MemorySettings } from '../../src/settings';
import { ToolRegistry } from '../../src/tools/registry';

class Bus implements EventBus {
  events: GlobalEventInput[] = [];
  async publish(e: GlobalEventInput) {
    this.events.push(e);
  }
  subscribe() {
    return () => undefined;
  }
}

const SECRET = 'sk-test-0123456789-very-secret';

/** The idempotency keys the SDK tool saw. */
let seenKeys: (string | undefined)[] = [];

function fakeServer(name: string) {
  const s = new McpServer({ name, version: '1.0.0' });
  s.registerTool(
    'count_words',
    { description: 'Count words', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: 'text', text: String(text.split(/\s+/).length) }] }),
  );
  s.registerTool(
    'wipe',
    { description: 'Delete everything', annotations: { destructiveHint: true } },
    async () => ({ content: [{ type: 'text', text: 'gone' }] }),
  );
  s.registerTool('post', { description: 'Post a note' }, async () => ({
    content: [{ type: 'text', text: 'posted' }],
  }));
  // A tool written with @nvx/plugin-sdk: its tier travels in _meta.
  const save = toMcpRegistration(
    defineTool({
      name: 'save',
      description: 'Save a snippet',
      input: z.object({ text: z.string() }),
      action: 'notes.save',
      tier: 'critical',
      resource: () => 'notes:/x',
      handler: async (_args, ctx) => {
        seenKeys.push(ctx.idempotencyKey);
        return 'saved';
      },
    }),
  );
  s.registerTool(save.name, save.config, save.handler as never);
  return s;
}

let registry: ToolRegistry;
let secrets: MemorySecretStore;
let settings: MemorySettings;
let store: MemoryMcpServerStore;
let bus: Bus;
let mcp: McpManager;
let service: McpService;
let app: Hono<AppEnv>;
/** Latest server per name, what each connect was given, and how often it connected. */
let servers: Map<string, McpServer>;
let resolved: Map<string, Record<string, string>>;
let connects: Map<string, number>;
let refuse: Set<string>;

const FILES: McpServerSpec[] = [
  {
    name: 'filesrv',
    transport: 'stdio',
    command: 'file-server',
    args: ['--x'],
    env_secrets: ['FILE_TOKEN'],
    enabled: true,
    tools: { post: { tier: 'critical' } },
  },
];

function build(files: McpServerSpec[] = FILES) {
  registry = new ToolRegistry();
  secrets = new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64')));
  settings = new MemorySettings();
  store = new MemoryMcpServerStore();
  bus = new Bus();
  servers = new Map();
  resolved = new Map();
  connects = new Map();
  refuse = new Set();
  seenKeys = [];
  mcp = new McpManager(registry, {
    secrets,
    events: bus,
    transport: (spec, env) => {
      resolved.set(spec.name, env);
      connects.set(spec.name, (connects.get(spec.name) ?? 0) + 1);
      if (refuse.has(spec.name)) throw new Error('spawn ENOENT');
      const s = fakeServer(spec.name);
      servers.set(spec.name, s);
      const [a, b] = InMemoryTransport.createLinkedPair();
      void s.connect(b);
      return a;
    },
  });
  service = new McpService({ store, secrets, settings, manager: mcp, files });
  app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', toolRoutes({ tools: registry, servers: service }));
}

beforeEach(() => build());
afterEach(async () => {
  await mcp.stop();
  for (const s of servers.values()) await s.close().catch(() => undefined);
});

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const toolNames = async () =>
  ((await (await app.request('/tools')).json()) as { items: { name: string; tier: string }[] }).items;
const list = async () =>
  ((await (await app.request('/mcp/servers')).json()) as { items: McpServerView[] }).items;

async function until(check: () => boolean | Promise<boolean>, ms = 3_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const connected = (id: string) => until(async () => (await service.view(id)).status === 'connected');

async function addNotes(over: Record<string, unknown> = {}) {
  const res = await send('POST', '/mcp/servers', {
    name: 'notes',
    transport: 'stdio',
    command: 'notes-server',
    args: ['--fast'],
    env: { LOG_LEVEL: 'debug' },
    secrets: [{ key: 'NOTES_TOKEN', value: SECRET }],
    ...over,
  });
  expect(res.status).toBe(201);
  const text = await res.text();
  expect(text).not.toContain(SECRET);
  return JSON.parse(text) as McpServerView;
}

describe('adding a server', () => {
  it('adds a stdio server, connects in the background, and never returns a secret', async () => {
    await service.start();
    const added = await addNotes();
    expect(added).toMatchObject({
      name: 'notes',
      source: 'app',
      transport: 'stdio',
      command: 'notes-server',
      args: ['--fast'],
      env: { LOG_LEVEL: 'debug' },
      secrets: [{ key: 'NOTES_TOKEN', set: true }],
      status: 'connecting',
      enabled: true,
    });
    expect(added.id).toMatch(/^mcp_/);
    await connected(added.id);
    // Plain env and the secret reach the server's environment.
    expect(resolved.get('notes')).toEqual({ LOG_LEVEL: 'debug', NOTES_TOKEN: SECRET });
    expect(await secrets.get(mcpSecretName(added.id, 'NOTES_TOKEN'))).toBe(SECRET);
    // Its tools are callable at once, without a restart.
    expect((await toolNames()).map((t) => t.name)).toEqual(
      expect.arrayContaining(['notes__count_words', 'notes__wipe', 'notes__post', 'notes__save']),
    );
    const all = await (await app.request('/mcp/servers')).text();
    expect(all).not.toContain(SECRET);
    const items = (JSON.parse(all) as { items: McpServerView[] }).items;
    expect(items.map((s) => [s.id, s.source])).toEqual([
      ['file:filesrv', 'file'],
      [added.id, 'app'],
    ]);
    const notes = items[1] as McpServerView;
    expect(notes.status).toBe('connected');
    expect(notes.connected_at).not.toBeNull();
    expect(notes.tools.find((t) => t.name === 'wipe')).toMatchObject({
      id: 'notes__wipe',
      tier: 'critical',
      default_tier: 'critical',
      destructive: true,
      read_only: false,
      overridden: false,
      disabled: false,
    });
    expect(notes.tools.find((t) => t.name === 'count_words')).toMatchObject({
      tier: 'auto',
      read_only: true,
    });
    // Live state went out as events, with the tool count.
    const changes = bus.events.filter(
      (e): e is Extract<GlobalEventInput, { type: 'mcp.server_changed' }> =>
        e.type === 'mcp.server_changed' && e.server_id === added.id,
    );
    expect(changes.map((e) => e.status)).toEqual(['connecting', 'connected']);
    expect(changes.at(-1)?.tools).toBe(4);
  });

  it('adds an http server whose secrets become request headers', async () => {
    const res = await send('POST', '/mcp/servers', {
      name: 'remote',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { 'X-Team': 'blue' },
      secrets: [{ key: 'Authorization', value: `Bearer ${SECRET}` }],
    });
    expect(res.status).toBe(201);
    const v = (await res.json()) as McpServerView;
    expect(v).toMatchObject({ transport: 'http', url: 'https://mcp.example.com/mcp', command: null });
    await connected(v.id);
    expect(resolved.get('remote')).toEqual({ 'X-Team': 'blue', Authorization: `Bearer ${SECRET}` });
  });

  it('passes headers to the real Streamable HTTP transport', () => {
    const t = defaultTransport(
      { name: 'r', transport: 'http', url: 'https://x.example/mcp', oauth: false, enabled: true, tools: {} },
      { Authorization: 'Bearer t' },
    ) as unknown as { _requestInit?: { headers?: Record<string, string> } };
    expect(t._requestInit?.headers).toEqual({ Authorization: 'Bearer t' });
  });

  it('refuses a taken name, a bad body and a secret without a value', async () => {
    const file = await send('POST', '/mcp/servers', { name: 'filesrv', transport: 'stdio', command: 'x' });
    expect(file.status).toBe(409);
    expect(await code(file)).toBe('mcp.name_taken');
    await addNotes();
    const dup = await send('POST', '/mcp/servers', { name: 'notes', transport: 'stdio', command: 'x' });
    expect(dup.status).toBe(409);
    expect(await code(dup)).toBe('mcp.name_taken');
    const bad = await send('POST', '/mcp/servers', { name: 'Bad Name', transport: 'stdio', command: 'x' });
    expect(bad.status).toBe(400);
    expect(await code(bad)).toBe('request.invalid');
    const mixed = await send('POST', '/mcp/servers', {
      name: 'mixed',
      transport: 'stdio',
      command: 'x',
      url: 'https://a.example',
    });
    expect(mixed.status).toBe(400);
    const empty = await send('POST', '/mcp/servers', {
      name: 'empty',
      transport: 'stdio',
      command: 'x',
      secrets: [{ key: 'TOKEN' }],
    });
    expect(empty.status).toBe(400);
    expect(await code(empty)).toBe('mcp.secret_missing');
    expect((await list()).map((s) => s.name)).toEqual(['filesrv', 'notes']);
  });

  it('shows a server that will not start as an error, in words', async () => {
    refuse.add('broken');
    const res = await send('POST', '/mcp/servers', { name: 'broken', transport: 'stdio', command: 'nope' });
    const v = (await res.json()) as McpServerView;
    await until(async () => (await service.view(v.id)).status === 'error');
    expect(await service.view(v.id)).toMatchObject({ last_error: 'spawn ENOENT', tools: [] });
    expect(bus.events).toContainEqual(
      expect.objectContaining({ type: 'mcp.server_changed', status: 'error', detail: 'spawn ENOENT' }),
    );
  });
});

describe('changing a server', () => {
  it('keeps a secret sent without a value, deletes one left out, adds a new one', async () => {
    const v = await addNotes({
      secrets: [
        { key: 'A', value: 'value-a' },
        { key: 'B', value: 'value-b' },
      ],
    });
    await connected(v.id);
    const res = await send('PATCH', `/mcp/servers/${v.id}`, {
      secrets: [{ key: 'A' }, { key: 'C', value: 'value-c' }],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/value-[abc]/);
    expect((JSON.parse(text) as McpServerView).secrets).toEqual([
      { key: 'A', set: true },
      { key: 'C', set: true },
    ]);
    expect(await secrets.get(mcpSecretName(v.id, 'A'))).toBe('value-a');
    expect(await secrets.get(mcpSecretName(v.id, 'B'))).toBeUndefined();
    expect(await secrets.get(mcpSecretName(v.id, 'C'))).toBe('value-c');
    await connected(v.id);
    expect(resolved.get('notes')).toEqual({ LOG_LEVEL: 'debug', A: 'value-a', C: 'value-c' });

    // A key with no value and nothing stored is refused, and nothing changes.
    const missing = await send('PATCH', `/mcp/servers/${v.id}`, { secrets: [{ key: 'A' }, { key: 'D' }] });
    expect(missing.status).toBe(400);
    expect(await code(missing)).toBe('mcp.secret_missing');
    expect((await service.view(v.id)).secrets.map((s) => s.key)).toEqual(['A', 'C']);
  });

  it('refuses fields of the other transport, and names already taken', async () => {
    const v = await addNotes();
    const wrong = await send('PATCH', `/mcp/servers/${v.id}`, { url: 'https://a.example/mcp' });
    expect(wrong.status).toBe(400);
    expect(await code(wrong)).toBe('mcp.transport_mismatch');
    const header = await send('PATCH', `/mcp/servers/${v.id}`, {
      secrets: [{ key: 'Not An Env', value: 'x' }],
    });
    expect(header.status).toBe(400);
    const taken = await send('PATCH', `/mcp/servers/${v.id}`, { name: 'filesrv' });
    expect(taken.status).toBe(409);
    expect(await code(taken)).toBe('mcp.name_taken');
    const unknown = await send('PATCH', '/mcp/servers/mcp_NOPE', { enabled: false });
    expect(unknown.status).toBe(404);
    expect(await code(unknown)).toBe('mcp.not_found');
  });

  it('applies a rename and a switch-off at once, and does not reconnect for nothing', async () => {
    const v = await addNotes();
    await connected(v.id);
    const renamed = await send('PATCH', `/mcp/servers/${v.id}`, { name: 'jotter' });
    expect(renamed.status).toBe(200);
    await connected(v.id);
    const names = (await toolNames()).map((t) => t.name);
    expect(names).toContain('jotter__count_words');
    expect(names).not.toContain('notes__count_words');
    expect(registry.get('jotter__post')?.action).toBe('mcp.jotter.post');

    const off = (await (
      await send('PATCH', `/mcp/servers/${v.id}`, { enabled: false })
    ).json()) as McpServerView;
    expect(off).toMatchObject({ enabled: false, status: 'disabled', tools: [] });
    expect((await toolNames()).some((t) => t.name.startsWith('jotter__'))).toBe(false);
    expect(bus.events.at(-1)).toMatchObject({ type: 'mcp.server_changed', status: 'disabled', tools: 0 });

    await send('PATCH', `/mcp/servers/${v.id}`, { enabled: true });
    await connected(v.id);
    expect((await toolNames()).some((t) => t.name === 'jotter__wipe')).toBe(true);
    const before = connects.get('jotter');
    // Sending the secrets back unchanged changes nothing that needs a reconnect.
    await send('PATCH', `/mcp/servers/${v.id}`, { secrets: [{ key: 'NOTES_TOKEN' }] });
    expect(connects.get('jotter')).toBe(before);
  });

  it('removes a server: tools, secrets and row go, and the UI hears it', async () => {
    const v = await addNotes();
    await connected(v.id);
    const res = await send('DELETE', `/mcp/servers/${v.id}`);
    expect(res.status).toBe(204);
    expect((await toolNames()).some((t) => t.name.startsWith('notes__'))).toBe(false);
    expect(await secrets.get(mcpSecretName(v.id, 'NOTES_TOKEN'))).toBeUndefined();
    expect(bus.events.at(-1)).toMatchObject({
      type: 'mcp.server_changed',
      server_id: v.id,
      status: 'removed',
      tools: 0,
    });
    const again = await send('DELETE', `/mcp/servers/${v.id}`);
    expect(again.status).toBe(404);
    expect(await code(again)).toBe('mcp.not_found');
  });

  it('tests a server: reconnects and answers with the view', async () => {
    const v = await addNotes();
    await connected(v.id);
    const res = await send('POST', `/mcp/servers/${v.id}/test`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: v.id, status: 'connected' });
    expect(connects.get('notes')).toBe(2);
    expect((await send('POST', '/mcp/servers/mcp_NOPE/test')).status).toBe(404);
  });
});

describe('servers from config/mcp.yaml', () => {
  it('are listed read-only, and their tools can still be changed', async () => {
    await secrets.set('FILE_TOKEN', SECRET);
    await service.start();
    await connected('file:filesrv');
    const v = await service.view('file:filesrv');
    expect(v).toMatchObject({
      source: 'file',
      command: 'file-server',
      args: ['--x'],
      secrets: [{ key: 'FILE_TOKEN', set: true }],
    });
    expect(JSON.stringify(v)).not.toContain(SECRET);
    // The YAML override applies.
    expect(v.tools.find((t) => t.name === 'post')).toMatchObject({ tier: 'critical', overridden: true });

    const patch = await send('PATCH', '/mcp/servers/file:filesrv', { enabled: false });
    expect(patch.status).toBe(409);
    expect(await code(patch)).toBe('mcp.read_only');
    const del = await send('DELETE', `/mcp/servers/${encodeURIComponent('file:filesrv')}`);
    expect(del.status).toBe(409);
    expect(await code(del)).toBe('mcp.read_only');

    const tool = await send('PATCH', '/mcp/servers/file:filesrv/tools/count_words', { disabled: true });
    expect(tool.status).toBe(200);
    expect((await toolNames()).some((t) => t.name === 'filesrv__count_words')).toBe(false);
    expect(await settings.get(MCP_FILE_OVERRIDES_SETTING)).toEqual({
      filesrv: { count_words: { disabled: true } },
    });
    // Clearing the app's tier goes back to the YAML one, not the server's hint.
    await send('PATCH', '/mcp/servers/file:filesrv/tools/post', { tier: 'gated' });
    expect(registry.get('filesrv__post')?.tier).toBe('gated');
    await send('PATCH', '/mcp/servers/file:filesrv/tools/post', { tier: null });
    expect(registry.get('filesrv__post')?.tier).toBe('critical');
    expect(connects.get('filesrv')).toBe(1);
  });

  it('win over an app server with the same name', async () => {
    await store.create({
      id: 'mcp_OLD',
      name: 'filesrv',
      transport: 'stdio',
      command: 'other',
      args: [],
      env: {},
      url: null,
      headers: {},
      secret_keys: [],
      enabled: true,
      tool_overrides: {},
    });
    await service.start();
    await connected('file:filesrv');
    expect(resolved.size).toBe(1);
    expect(await service.view('mcp_OLD')).toMatchObject({ status: 'error', tools: [] });
  });
});

describe('per-tool settings', () => {
  it('re-register at once, never make a destructive tool auto, and clear with null', async () => {
    const v = await addNotes();
    await connected(v.id);
    const set = await send('PATCH', `/mcp/servers/${v.id}/tools/post`, { tier: 'auto' });
    expect(set.status).toBe(200);
    expect(((await set.json()) as McpServerView).tools.find((t) => t.name === 'post')).toMatchObject({
      tier: 'auto',
      default_tier: 'gated',
      overridden: true,
    });
    expect((await toolNames()).find((t) => t.name === 'notes__post')?.tier).toBe('auto');

    const destructive = await send('PATCH', `/mcp/servers/${v.id}/tools/wipe`, { tier: 'auto' });
    expect(destructive.status).toBe(400);
    expect(await code(destructive)).toBe('mcp.tier_not_allowed');
    expect(registry.get('notes__wipe')?.tier).toBe('critical');

    await send('PATCH', `/mcp/servers/${v.id}/tools/wipe`, { disabled: true });
    expect(registry.get('notes__wipe')).toBeUndefined();
    const view = await service.view(v.id);
    expect(view.tools.find((t) => t.name === 'wipe')).toMatchObject({ disabled: true });

    await send('PATCH', `/mcp/servers/${v.id}/tools/post`, { tier: null });
    expect(registry.get('notes__post')?.tier).toBe('gated');
    await send('PATCH', `/mcp/servers/${v.id}/tools/wipe`, { disabled: false });
    expect(registry.get('notes__wipe')?.tier).toBe('critical');
    expect(connects.get('notes')).toBe(1);
    // Kept with the server.
    expect((await store.get(v.id))?.tool_overrides).toEqual({});

    const unknownTool = await send('PATCH', `/mcp/servers/${v.id}/tools/nope`, { tier: 'gated' });
    expect(unknownTool.status).toBe(404);
    expect(await code(unknownTool)).toBe('mcp.tool_not_found');
    const unknownServer = await send('PATCH', '/mcp/servers/mcp_NOPE/tools/post', { tier: 'gated' });
    expect(await code(unknownServer)).toBe('mcp.not_found');
    const bad = await send('PATCH', `/mcp/servers/${v.id}/tools/post`, { tier: 'sometimes' });
    expect(bad.status).toBe(400);
  });

  it('survive a reconnect', async () => {
    const v = await addNotes();
    await connected(v.id);
    await send('PATCH', `/mcp/servers/${v.id}/tools/post`, { tier: 'critical' });
    await send('POST', `/mcp/servers/${v.id}/test`);
    expect(registry.get('notes__post')?.tier).toBe('critical');
  });
});

describe('what a server says about its tools', () => {
  it('takes the tier from @nvx/plugin-sdk metadata and passes the idempotency key on each call', async () => {
    const v = await addNotes();
    await connected(v.id);
    const save = (await service.view(v.id)).tools.find((t) => t.name === 'save');
    expect(save).toMatchObject({ tier: 'critical', default_tier: 'critical' });
    expect(registry.get('notes__count_words')?.readOnly).toBe(true);
    expect(registry.get('notes__post')?.readOnly).toBeUndefined();
    const out = await registry
      .get('notes__save')
      ?.execute({ text: 'x' }, { idempotencyKey: 'run_1:stp_2', signal: new AbortController().signal });
    expect(out).toBe('saved');
    expect(seenKeys).toEqual(['run_1:stp_2']);
  });

  it('re-lists when the server says its tools changed', async () => {
    const v = await addNotes();
    await connected(v.id);
    const before = bus.events.length;
    servers.get('notes')?.registerTool('fresh', { description: 'New' }, async () => ({
      content: [{ type: 'text', text: 'hi' }],
    }));
    await until(() => registry.get('notes__fresh') !== undefined);
    expect((await service.view(v.id)).tools.some((t) => t.name === 'fresh')).toBe(true);
    expect(bus.events.slice(before)).toContainEqual(
      expect.objectContaining({ type: 'mcp.server_changed', server_id: v.id, status: 'connected', tools: 5 }),
    );
    expect(connects.get('notes')).toBe(1);
  });
});

describe('servers the GitHub preset saved in settings', () => {
  it('move into the server list once, with their secret, and connect', async () => {
    await secrets.set('GITHUB_PERSONAL_ACCESS_TOKEN', SECRET);
    await settings.set(MCP_ADDED_SETTING, [
      {
        name: 'github',
        transport: 'stdio',
        command: 'github-mcp-server',
        args: ['stdio'],
        env_secrets: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
        enabled: true,
        tools: { post: { tier: 'critical' } },
      },
    ]);
    await service.start();
    const row = await store.byName('github');
    expect(row).toMatchObject({
      command: 'github-mcp-server',
      args: ['stdio'],
      secret_keys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
      tool_overrides: { post: { tier: 'critical' } },
    });
    expect(await secrets.get(mcpSecretName(row?.id ?? '', 'GITHUB_PERSONAL_ACCESS_TOKEN'))).toBe(SECRET);
    expect(await settings.get(MCP_ADDED_SETTING)).toEqual([]);
    await connected(row?.id ?? '');
    expect(resolved.get('github')).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: SECRET });
    expect(registry.get('github__post')?.tier).toBe('critical');
    // Again: nothing more to move.
    await service.migrateLegacy();
    expect((await store.list()).length).toBe(1);
  });

  it('the preset saves an app server, and updates it when added again', async () => {
    const first = await service.savePreset({
      name: 'github',
      command: 'docker',
      args: ['run'],
      secrets: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: 'one' }],
    });
    expect(first.health).toMatchObject({ connected: true, tools: 4 });
    expect(first.view).toMatchObject({ source: 'app', command: 'docker', status: 'connected' });
    const again = await service.savePreset({
      name: 'github',
      command: 'github-mcp-server',
      args: ['stdio'],
      secrets: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: 'two' }],
    });
    expect(again.view.id).toBe(first.view.id);
    expect(resolved.get('github')).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'two' });
    await expect(
      service.savePreset({ name: 'filesrv', command: 'x', args: [], secrets: [] }),
    ).rejects.toMatchObject({ code: 'mcp.name_taken' });
  });
});
