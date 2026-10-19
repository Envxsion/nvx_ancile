/**
 * ------------------------------------------------------------------
 *  Title    |  MCP presets and the SSE transport
 *  Ref      |  ROADMAP MC2
 *  ID       |  core/test/mcp
 * ------------------------------------------------------------------
 *  Purpose  |  The Add server catalogue: every preset builds a valid
 *           |  request, secrets stay out of arguments and views, a
 *           |  missing runtime and a missing field say what to do, a
 *           |  server that cannot start is reported (not thrown), and an
 *           |  SSE server connects with its secret header.
 * ------------------------------------------------------------------
 */

import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CreateMcpServerRequest, type McpPreset, type McpServerView } from '@nvx/contracts';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/app';
import type { EventBus, GlobalEventInput } from '../../src/events/bus';
import { defaultTransport, McpManager, mcpToolName } from '../../src/mcp/manager';
import { MCP_PRESETS, McpPresets } from '../../src/mcp/presets';
import { toolRoutes } from '../../src/mcp/routes';
import { McpService } from '../../src/mcp/service';
import { MemoryMcpServerStore } from '../../src/mcp/store';
import { errorHandler } from '../../src/obs/errors';
import { MemorySecretStore, SecretBox } from '../../src/secrets';
import { MemorySettings } from '../../src/settings';
import { ToolRegistry } from '../../src/tools/registry';

class Bus implements EventBus {
  async publish(_e: GlobalEventInput) {}
  subscribe() {
    return () => undefined;
  }
}

const TOKEN = 'xoxb-0123456789-very-secret-token';

let app: Hono<AppEnv>;
let mcp: McpManager;
let service: McpService;
let secrets: MemorySecretStore;
let seen: { name: string; transport: string; env: Record<string, string> }[];
let installed: Set<string>;
let refuse: Set<string>;
const servers: McpServer[] = [];

beforeEach(() => {
  seen = [];
  installed = new Set(['npx', 'uvx']);
  refuse = new Set();
  secrets = new MemorySecretStore(new SecretBox(Buffer.alloc(32, 7).toString('base64')));
  const registry = new ToolRegistry();
  mcp = new McpManager(registry, {
    secrets,
    events: new Bus(),
    transport: (spec, env) => {
      seen.push({ name: spec.name, transport: spec.transport, env });
      if (refuse.has(spec.name)) throw new Error('spawn npx ENOENT');
      const s = new McpServer({ name: spec.name, version: '1.0.0' });
      s.registerTool('ping', { description: 'Ping' }, async () => ({
        content: [{ type: 'text', text: 'pong' }],
      }));
      servers.push(s);
      const [a, b] = InMemoryTransport.createLinkedPair();
      void s.connect(b);
      return a;
    },
  });
  service = new McpService({
    store: new MemoryMcpServerStore(),
    secrets,
    settings: new MemorySettings(),
    manager: mcp,
    files: [],
  });
  const presets = new McpPresets(service, async (p) => installed.has(p));
  app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', toolRoutes({ tools: registry, servers: service, presets }));
});
afterEach(async () => {
  await mcp.stop();
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const presetList = async () =>
  ((await (await app.request('/mcp/presets')).json()) as { items: McpPreset[] }).items;
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('the catalogue', () => {
  it('lists the presets people reach for, each with fields in plain words', async () => {
    const items = await presetList();
    const ids = items.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'filesystem',
        'playwright',
        'linear',
        'sentry',
        'supabase',
        'context7',
        'brave-search',
      ]),
    );
    // Archived, unsupported or OAuth-only servers are not offered (see presets.ts).
    for (const gone of ['postgres', 'slack', 'notion', 'vercel']) expect(ids).not.toContain(gone);
    for (const p of items) {
      expect(p.description.length).toBeGreaterThan(10);
      expect(p.description).not.toContain('—');
      for (const f of p.fields) expect(f.label.length).toBeGreaterThan(1);
    }
    expect(items.find((p) => p.id === 'linear')?.transport).toBe('http');
  });

  it('builds a valid request from every preset with its fields filled in', () => {
    const presets = new McpPresets(service);
    for (const d of MCP_PRESETS) {
      const values = Object.fromEntries(
        d.fields.map((f) => [f.key, f.secret ? 'a-secret-value' : 'plain-value']),
      );
      const req = presets.build(d as never, values, d.id);
      expect(CreateMcpServerRequest.safeParse(req).success, d.id).toBe(true);
      // A secret field is never an argument or a plain setting.
      for (const f of d.fields.filter((x) => x.secret)) {
        const json = JSON.stringify({ ...req, secrets: [] });
        expect(json, `${d.id}:${f.key}`).not.toContain('a-secret-value');
      }
    }
  });

  it('says what is missing when Node or Python is not installed, and refuses to add it', async () => {
    installed.delete('npx');
    installed.delete('uvx');
    const items = await presetList();
    const brave = items.find((p) => p.id === 'brave-search') as McpPreset;
    expect(brave.available).toBe(false);
    expect(brave.missing).toMatch(/Install Node\.js from nodejs\.org/);
    expect(items.find((p) => p.id === 'git')?.missing).toMatch(/Install uv from/);
    // A remote server needs neither.
    expect(items.find((p) => p.id === 'linear')?.available).toBe(true);
    const res = await post('/mcp/presets/brave-search/add', { fields: { BRAVE_API_KEY: TOKEN } });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('mcp.runtime_missing');
  });
});

describe('adding a preset', () => {
  it('stores the token as a named secret, connects, and returns no secret', async () => {
    const res = await post('/mcp/presets/brave-search/add', { fields: { BRAVE_API_KEY: TOKEN } });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    const view = JSON.parse(text) as McpServerView;
    expect(view).toMatchObject({
      name: 'brave-search',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@brave/brave-search-mcp-server', '--transport', 'stdio'],
      secrets: [{ key: 'BRAVE_API_KEY', set: true }],
      status: 'connected',
    });
    expect(await secrets.names()).toContain(`mcp.${view.id}.BRAVE_API_KEY`);
    expect(seen[0]?.env).toMatchObject({ BRAVE_API_KEY: TOKEN });
    expect((await presetList()).find((p) => p.id === 'brave-search')?.added).toBe(true);
  });

  it('turns a list of folders into separate arguments', async () => {
    const res = await post('/mcp/presets/filesystem/add', { fields: { folders: 'C:\\a\n C:\\b \n\n' } });
    const view = (await res.json()) as McpServerView;
    expect(view.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', 'C:\\a', 'C:\\b']);
  });

  it('names the field that is missing, and refuses a second line in a token', async () => {
    const missing = await post('/mcp/presets/sentry/add', { fields: {} });
    expect(missing.status).toBe(400);
    const body = (await missing.json()) as {
      error: { code: string; title: string; context: { field: string } };
    };
    expect(body.error).toMatchObject({ code: 'mcp.preset_field', context: { field: 'SENTRY_ACCESS_TOKEN' } });
    expect(body.error.title).toBe('Access token: this is needed');
    const multi = await post('/mcp/presets/sentry/add', { fields: { SENTRY_ACCESS_TOKEN: 'a\nb' } });
    expect(await code(multi)).toBe('mcp.preset_field');
    expect((await post('/mcp/presets/nope/add', { fields: {} })).status).toBe(404);
  });

  it('reports a server that cannot start in its status, with the reason, instead of failing', async () => {
    refuse.add('playwright');
    const res = await post('/mcp/presets/playwright/add', { fields: {} });
    expect(res.status).toBe(201);
    const view = (await res.json()) as McpServerView;
    expect(view.status).toBe('error');
    expect(view.last_error).toMatch(/ENOENT/);
  });

  it('refuses a second server under the same name, and takes another name', async () => {
    expect((await post('/mcp/presets/playwright/add', { fields: {} })).status).toBe(201);
    const again = await post('/mcp/presets/playwright/add', { fields: {} });
    expect(await code(again)).toBe('mcp.name_taken');
    const other = await post('/mcp/presets/playwright/add', { fields: {}, name: 'browser-two' });
    expect(other.status).toBe(201);
  });
});

describe('the sse transport', () => {
  it('adds a remote preset whose header secret reaches the connection', async () => {
    const res = await post('/mcp/presets/linear/add', {
      fields: { Authorization: 'lin_api_SECRETVALUE0123' },
    });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('lin_api_SECRETVALUE0123');
    const view = JSON.parse(text) as McpServerView;
    expect(view).toMatchObject({ transport: 'http', url: 'https://mcp.linear.app/mcp', status: 'connected' });
    expect(seen[0]).toMatchObject({
      transport: 'http',
      env: { Authorization: 'Bearer lin_api_SECRETVALUE0123' },
    });
  });

  it('is accepted by hand, with a web address, and edited like an http server', async () => {
    const res = await post('/mcp/servers', {
      name: 'events',
      transport: 'sse',
      url: 'https://example.com/sse',
    });
    expect(res.status).toBe(201);
    const bad = await post('/mcp/servers', { name: 'oops', transport: 'sse', command: 'x' });
    expect(bad.status).toBe(400);
    const view = (await res.json()) as McpServerView;
    const patched = await app.request(`/mcp/servers/${view.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'x' }),
    });
    expect(await code(patched)).toBe('mcp.transport_mismatch');
  });

  it('uses the server-sent-events client for an sse server', () => {
    const t = defaultTransport(
      { name: 'x', transport: 'sse', url: 'https://example.com/sse', enabled: true, tools: {} } as never,
      { Authorization: 'Bearer x' },
    );
    expect(t).toBeInstanceOf(SSEClientTransport);
  });
});

describe('tool name clashes', () => {
  it('keeps two servers that offer the same tool apart, and a clash with a clean name stable', () => {
    expect(mcpToolName('files', 'read')).toBe('files__read');
    const taken = new Set(['files__read']);
    const second = mcpToolName('files', 'read', (n) => taken.has(n));
    expect(second).not.toBe('files__read');
    expect(second).toBe(mcpToolName('files', 'read', (n) => taken.has(n)));
    // Characters providers refuse are cleaned, and two that clean the same do not collide.
    expect(mcpToolName('a.b', 'c')).not.toBe(mcpToolName('a_b', 'c'));
  });
});
