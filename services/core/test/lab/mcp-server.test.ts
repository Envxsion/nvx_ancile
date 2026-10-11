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

async function setup() {
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
  const gate = createGate({ policy: new BuiltinPolicy(), store: perms, workspaceRoot: '/workspace' });
  const passes = new LabPasses();
  const endpoint = new LabMcpEndpoint({
    registry,
    gate,
    passes,
    token: TOKEN,
    userId: 'usr_1',
    workspaceId: 'wsp_1',
    version: 'test',
    notifyDelayMs: 5,
  });
  cleanups.push(async () => {
    await endpoint.close();
    await mcp.stop();
  });
  return { registry, mcp, perms, gate, passes, endpoint };
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
