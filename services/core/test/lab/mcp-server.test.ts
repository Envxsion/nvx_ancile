/**
 * The lab's MCP server: the lab sees the hosted MCP tools (never the
 * built-ins) behind its own token, every call passes the gate as
 * agent:lab, a person's approval in the bridge lets exactly one call
 * through, and the list follows the registry live.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Engine, EngineEvent } from '../../src/lab/engine-client';
import { LAB_PRINCIPAL, LabMirror } from '../../src/lab/event-mirror';
import { LabPasses } from '../../src/lab/hosted';
import { LabMcpEndpoint } from '../../src/lab/mcp-server';
import { McpManager, type McpServerSpec } from '../../src/mcp/manager';
import { BuiltinPolicy } from '../../src/permissions/cedar';
import { createGate } from '../../src/permissions/gate';
import { MemoryPermissionStore } from '../../src/permissions/store';
import { MemoryRunEventLog } from '../../src/runs/events';
import { MemoryScopeStore, type ScopeResolver, scopeResolver } from '../../src/scopes';
import { ToolRegistry } from '../../src/tools/registry';

const TOKEN = 'lab-token-'.padEnd(40, 'x');
const URL_ = 'http://core.test/mcp/lab';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function notesServer() {
  const s = new McpServer({ name: 'notes', version: '1.0.0' });
  s.registerTool(
    'count_words',
    { description: 'Count words', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({
      content: [{ type: 'text', text: String(text.split(/\s+/).filter(Boolean).length) }],
    }),
  );
  s.registerTool(
    'post',
    { description: 'Post a note', inputSchema: { body: z.string() } },
    async ({ body }) => ({ content: [{ type: 'text', text: `posted: ${body}` }] }),
  );
  return s;
}

const spec = (name: string): McpServerSpec =>
  ({
    name,
    transport: 'stdio',
    command: 'unused',
    args: [],
    env_secrets: [],
    enabled: true,
    tools: {},
  }) as McpServerSpec;

async function setup(opts: { scopes?: ScopeResolver; notebooks?: Record<string, string | null> } = {}) {
  /** The lab runs the engine is working on now: tests move this the way the mirror does. */
  const running: { threadId: string; workspaceId: string }[] = [];
  const registry = new ToolRegistry();
  // A built-in the lab must never see through this server.
  registry.register({
    name: 'fs_read',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: {} },
    action: 'fs.read',
    tier: 'auto',
    destructive: false,
    source: { kind: 'builtin' },
    resource: () => 'fs:/workspace',
    execute: async () => 'contents',
  });
  const mcp = new McpManager(registry, {
    transport: () => {
      const [a, b] = InMemoryTransport.createLinkedPair();
      void notesServer().connect(b);
      return a;
    },
  });
  await mcp.connect(spec('notes'));
  const perms = new MemoryPermissionStore();
  const gate = createGate({
    policy: new BuiltinPolicy(),
    store: perms,
    workspaceRoot: '/workspace',
    ...(opts.scopes && { scopes: opts.scopes }),
  });
  const passes = new LabPasses();
  const endpoint = new LabMcpEndpoint({
    registry,
    gate,
    passes,
    token: TOKEN,
    userId: 'usr_1',
    workspaceId: 'wsp_1',
    turns: () => running,
    notebookOf: async (id) => opts.notebooks?.[id] ?? null,
    version: 'test',
    notifyDelayMs: 5,
  });
  cleanups.push(async () => {
    await endpoint.close();
    await mcp.stop();
  });
  return { registry, mcp, perms, gate, passes, endpoint, running };
}

/** An MCP client whose HTTP goes straight into a handler. */
async function clientOf(handle: (req: Request) => Promise<Response>, token = TOKEN) {
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (input, init) => handle(new Request(input, init)),
  });
  const client = new Client({ name: 'lab', version: '1.0.0' });
  await client.connect(transport);
  cleanups.push(() => client.close().catch(() => undefined));
  return client;
}

const textOf = (r: unknown) =>
  ((r as { content: { type: string; text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('');

const grant = (perms: MemoryPermissionStore, action: string, effect: 'allow' | 'deny') =>
  perms.createGrant({
    userId: 'usr_1',
    principal: LAB_PRINCIPAL,
    actionPattern: action,
    resourcePattern: 'mcp:notes/**',
    effect,
    scope: 'always',
    scopeRef: null,
    expiresAt: null,
    fromApprovalId: null,
  });

describe('the lab’s MCP server', () => {
  it('lists the hosted MCP tools with their schemas, and no built-ins', async () => {
    const t = await setup();
    const client = await clientOf(t.endpoint.handle);
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual(['notes__count_words', 'notes__post']);
    const count = tools.find((x) => x.name === 'notes__count_words');
    expect(count?.description).toBe('Count words');
    expect(count?.inputSchema).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } });
  });

  it('refuses a missing or wrong token', async () => {
    const t = await setup();
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    };
    expect((await t.endpoint.handle(new Request(URL_, init))).status).toBe(401);
    const wrong = await t.endpoint.handle(
      new Request(URL_, { ...init, headers: { ...init.headers, authorization: 'Bearer nope' } }),
    );
    expect(wrong.status).toBe(401);
    await expect(clientOf(t.endpoint.handle, 'not-the-token')).rejects.toThrow();
  });

  it('runs an auto-tier tool, and logs the decision as the lab', async () => {
    const t = await setup();
    const client = await clientOf(t.endpoint.handle);
    const r = await client.callTool({ name: 'notes__count_words', arguments: { text: 'one two three' } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe('3');
    expect((await t.perms.listDecisions())[0]).toMatchObject({
      principal: LAB_PRINCIPAL,
      action: 'mcp.notes.count_words',
      resource: 'mcp:notes/count_words',
      outcome: 'auto',
    });
  });

  it('gates a call: no answer yet → error, deny → error, allow → runs', async () => {
    const t = await setup();
    const client = await clientOf(t.endpoint.handle);
    const call = () => client.callTool({ name: 'notes__post', arguments: { body: 'hi' } });

    const asked = await call();
    expect(asked.isError).toBe(true);
    expect(textOf(asked)).toMatch(/needs your approval/);

    const deny = await grant(t.perms, 'mcp.notes.post', 'deny');
    const denied = await call();
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/^Not allowed/);
    await t.perms.revokeGrant(deny.id);

    await grant(t.perms, 'mcp.notes.post', 'allow');
    const allowed = await call();
    expect(allowed.isError).toBeFalsy();
    expect(textOf(allowed)).toBe('posted: hi');
  });

  it('spends a pass from a person’s approval on one call only, and a deny beats it', async () => {
    const t = await setup();
    const client = await clientOf(t.endpoint.handle);
    const call = () => client.callTool({ name: 'notes__post', arguments: { body: 'x' } });
    t.passes.grant('notes__post');
    expect(textOf(await call())).toBe('posted: x');
    expect((await call()).isError).toBe(true);

    t.passes.grant('notes__post');
    await grant(t.perms, 'mcp.notes.post', 'deny');
    expect(textOf(await call())).toMatch(/^Not allowed/);
  });

  it('follows the registry: a new server shows on the next list, and the session is told', async () => {
    const t = await setup();
    const client = await clientOf(t.endpoint.handle);
    const changed = vi.fn();
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => changed());
    expect((await client.listTools()).tools).toHaveLength(2);

    await t.mcp.connect(spec('more'));
    expect((await client.listTools()).tools.map((x) => x.name)).toContain('more__count_words');
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 2_000 });

    changed.mockClear();
    await t.mcp.disconnect('notes');
    expect((await client.listTools()).tools.map((x) => x.name).sort()).toEqual([
      'more__count_words',
      'more__post',
    ]);
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 2_000 });
  });

  it('answers a session it does not know (after a restart) without one', async () => {
    const t = await setup();
    const client = await clientOf(t.endpoint.handle);
    expect((await client.listTools()).tools).toHaveLength(2);
    // Core restarted: same registry, a new endpoint that never saw this session.
    const fresh = new LabMcpEndpoint({
      registry: t.registry,
      gate: t.gate,
      passes: t.passes,
      token: TOKEN,
      userId: 'usr_1',
      workspaceId: 'wsp_1',
      turns: () => [],
      notebookOf: async () => null,
      version: 'test',
    });
    cleanups.push(() => fresh.close());
    const sid = (client.transport as StreamableHTTPClientTransport).sessionId;
    expect(sid).toBeTruthy();
    const res = await fresh.handle(
      new Request(URL_, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sid as string,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools).toHaveLength(2);
  });
});

describe('a notebook’s scope reaches the lab’s hosted tools', () => {
  /** nb_locked (thread thr_locked) may not post; nb_open (thread thr_open) has no limits. */
  async function scoped() {
    const store = new MemoryScopeStore();
    store.threads.set('thr_locked', 'nb_locked');
    store.threads.set('thr_open', 'nb_open');
    await store.mergePatch('notebook', 'nb_locked', { tools_deny: ['mcp.notes.post'] });
    return setup({
      scopes: scopeResolver(store),
      notebooks: { thr_locked: 'nb_locked', thr_open: 'nb_open' },
    });
  }
  const post = (client: Awaited<ReturnType<typeof clientOf>>) =>
    client.callTool({ name: 'notes__post', arguments: { body: 'hi' } });

  it('refuses a tool the running thread’s notebook does not allow, in every preset', async () => {
    const t = await scoped();
    await grant(t.perms, 'mcp.notes.post', 'allow');
    const client = await clientOf(t.endpoint.handle);
    t.running.push({ threadId: 'thr_locked', workspaceId: 'wsp_1' });
    const refused = await post(client);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^Not allowed/);
    expect(textOf(refused)).toMatch(/cannot be approved here/);
    // It is in the decision log as a scope refusal, with the thread's own scope as the reason.
    expect((await t.perms.listDecisions())[0]).toMatchObject({
      outcome: 'policy_deny',
      principal: LAB_PRINCIPAL,
      action: 'mcp.notes.post',
    });
  });

  it('runs the same tool for a thread whose notebook allows it, and uses the thread it is told of', async () => {
    const t = await scoped();
    await grant(t.perms, 'mcp.notes.post', 'allow');
    const client = await clientOf(t.endpoint.handle);
    t.running.push({ threadId: 'thr_open', workspaceId: 'wsp_1' });
    expect(textOf(await post(client))).toBe('posted: hi');
  });

  it('with several lab runs working at once, the strictest scope decides', async () => {
    const t = await scoped();
    await grant(t.perms, 'mcp.notes.post', 'allow');
    const client = await clientOf(t.endpoint.handle);
    t.running.push(
      { threadId: 'thr_open', workspaceId: 'wsp_1' },
      { threadId: 'thr_locked', workspaceId: 'wsp_1' },
    );
    expect(textOf(await post(client))).toMatch(/^Not allowed/);
    t.running.splice(0, 2, { threadId: 'thr_open', workspaceId: 'wsp_1' });
    expect(textOf(await post(client))).toBe('posted: hi');
  });

  it('with no lab run active, falls back to the workspace scope, and still gates the call', async () => {
    const t = await scoped();
    const client = await clientOf(t.endpoint.handle);
    // Nothing granted: it asks, as it always did.
    expect(textOf(await post(client))).toMatch(/needs your approval/);
    await grant(t.perms, 'mcp.notes.post', 'allow');
    expect(textOf(await post(client))).toBe('posted: hi');
  });

  it('refuses the floors on the real arguments: a call that reaches Core’s own API', async () => {
    const t = await scoped();
    await grant(t.perms, 'mcp.notes.post', 'allow');
    const client = await clientOf(t.endpoint.handle);
    t.running.push({ threadId: 'thr_open', workspaceId: 'wsp_1' });
    const r = await client.callTool({
      name: 'notes__post',
      arguments: { body: 'curl http://localhost:7700/api/v1/approvals' },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/own API/);
  });

  it('lists a notebook’s own tool only for that notebook’s threads, and refuses the call otherwise', async () => {
    const t = await scoped();
    t.registry.register({
      name: 'nb_only',
      description: 'A tool of one notebook',
      inputSchema: { type: 'object', properties: {} },
      action: 'mcp.notes.nb_only',
      tier: 'auto',
      destructive: false,
      source: { kind: 'mcp', server: 'notes' },
      notebookId: 'nb_open',
      resource: () => 'mcp:notes/nb_only',
      execute: async () => 'for nb_open',
    });
    const client = await clientOf(t.endpoint.handle);
    const names = async () => (await client.listTools()).tools.map((x) => x.name);
    // Nothing running, or another notebook's thread: not offered, not callable.
    expect(await names()).not.toContain('nb_only');
    t.running.push({ threadId: 'thr_locked', workspaceId: 'wsp_1' });
    expect(await names()).not.toContain('nb_only');
    const refused = await client.callTool({ name: 'nb_only', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/There is no tool called/);
    // Its own notebook's thread: offered and run.
    t.running.splice(0, 1, { threadId: 'thr_open', workspaceId: 'wsp_1' });
    expect(await names()).toContain('nb_only');
    expect(textOf(await client.callTool({ name: 'nb_only', arguments: {} }))).toBe('for nb_open');
  });

  it('knows the runs the mirror is working on, and says when they change', async () => {
    const t = await setup();
    const engine = {
      pendingPermissions: async () => [],
      follow: async () => undefined,
    } as unknown as Engine;
    let changes = 0;
    const mirror = new LabMirror({
      engine,
      events: new MemoryRunEventLog(),
      gate: t.gate,
      permissions: t.perms,
      userId: 'usr_1',
      onTurns: () => {
        changes++;
      },
    });
    expect(mirror.activeTurns()).toEqual([]);
    await mirror.attach({
      runId: 'run_1',
      traceId: 't'.repeat(32),
      threadId: 'thr_open',
      workspaceId: 'wsp_1',
      messageId: 'msg_a',
      sessionId: 'ses_1',
      place: { realDir: '/srv/labs/thr_open', virtualDir: '/workspace/labs/thr_open' },
    });
    expect(mirror.activeTurns()).toEqual([{ threadId: 'thr_open', workspaceId: 'wsp_1' }]);
    expect(changes).toBe(1);
    await mirror.detach('ses_1');
    expect(mirror.activeTurns()).toEqual([]);
    expect(changes).toBe(2);
  });
});

describe('the bridge and hosted tools', () => {
  it('checks an ancile_ ask as the hosted tool, and an approval leaves one pass', async () => {
    const t = await setup();
    let push: (e: EngineEvent) => void = () => undefined;
    const replies: { id: string; reply: string }[] = [];
    const engine: Engine = {
      createSession: async () => ({ id: 'ses_1', directory: '/srv/labs/thr_1' }),
      prompt: async () => undefined,
      abort: async () => undefined,
      reply: async (id, _d, reply) => {
        replies.push({ id, reply });
      },
      pendingPermissions: async () => [],
      diff: async () => [],
      revert: async () => undefined,
      statuses: async () => ({}),
      messages: async () => [],
      follow: async (on) => {
        push = on;
      },
    };
    const mirror = new LabMirror({
      engine,
      events: new MemoryRunEventLog(),
      gate: t.gate,
      permissions: t.perms,
      userId: 'usr_1',
      tools: t.registry,
      passes: t.passes,
    });
    mirror.start();
    cleanups.push(async () => mirror.stop());
    await mirror.attach({
      runId: 'run_1',
      traceId: 't'.repeat(32),
      threadId: 'thr_1',
      workspaceId: 'wsp_1',
      messageId: 'msg_a',
      sessionId: 'ses_1',
      place: { realDir: '/srv/labs/thr_1', virtualDir: '/workspace/labs/thr_1' },
    });
    const ask = (id: string, permission: string) =>
      push({
        type: 'permission.asked',
        properties: { id, sessionID: 'ses_1', permission, patterns: ['*'], metadata: {} },
      });

    // A read-only hosted tool is auto: answered at once.
    ask('per_1', 'ancile_notes__count_words');
    await vi.waitFor(() => expect(replies).toEqual([{ id: 'per_1', reply: 'once' }]));

    // A gated one becomes an approval named after the hosted tool.
    ask('per_2', 'ancile_notes__post');
    await vi.waitFor(async () => expect(await t.perms.pendingApprovals()).toHaveLength(1));
    const [approval] = await t.perms.pendingApprovals();
    expect(approval).toMatchObject({
      tool: 'notes__post',
      action: 'mcp.notes.post',
      resource: 'mcp:notes/post',
      tier: 'gated',
    });
    if (!approval) throw new Error('no approval');
    await mirror.resolved(approval, 'approved');
    expect(replies.at(-1)).toEqual({ id: 'per_2', reply: 'once' });

    // The call that follows runs on that pass, once.
    const client = await clientOf(t.endpoint.handle);
    expect(textOf(await client.callTool({ name: 'notes__post', arguments: { body: 'ok' } }))).toBe(
      'posted: ok',
    );
    expect((await client.callTool({ name: 'notes__post', arguments: { body: 'again' } })).isError).toBe(true);
  });
});
