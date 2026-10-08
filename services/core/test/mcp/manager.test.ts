/**
 * MCP: a real SDK server over the in-memory transport. Tools land in the
 * registry with tiers from their annotations and overrides, calls go
 * through, errors surface, and a dropped server's tools disappear.
 */

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultTransport, McpManager, type McpServerSpec, mcpToolName } from '../../src/mcp/manager';
import { ToolRegistry } from '../../src/tools/registry';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

function server() {
  const s = new McpServer({ name: 'notes', version: '1.0.0' });
  s.registerTool(
    'count_words',
    { description: 'Count words', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({
      content: [{ type: 'text', text: String(text.split(/\s+/).filter(Boolean).length) }],
    }),
  );
  s.registerTool(
    'wipe',
    { description: 'Delete everything', annotations: { destructiveHint: true } },
    async () => ({ content: [{ type: 'text', text: 'gone' }] }),
  );
  s.registerTool('post', { description: 'Post a note' }, async () => ({
    content: [{ type: 'text', text: 'quota exceeded' }],
    isError: true,
  }));
  return s;
}

const spec = (over: Partial<McpServerSpec> = {}): McpServerSpec =>
  ({
    name: 'notes',
    transport: 'stdio',
    command: 'unused',
    args: [],
    env_secrets: [],
    enabled: true,
    tools: {},
    ...over,
  }) as McpServerSpec;

async function connected(over: Partial<McpServerSpec> = {}) {
  const registry = new ToolRegistry();
  const s = server();
  let clientSide: InMemoryTransport | undefined;
  const mcp = new McpManager(registry, {
    transport: () => {
      const [a, b] = InMemoryTransport.createLinkedPair();
      clientSide = a;
      void s.connect(b);
      return a;
    },
  });
  const health = await mcp.connect(spec(over));
  cleanup = async () => {
    await mcp.stop();
    await s.close();
  };
  return { registry, mcp, health, server: s, drop: () => clientSide?.close() };
}

describe('MCP manager', () => {
  it('registers tools with tiers from annotations', async () => {
    const { registry, health } = await connected();
    expect(health).toMatchObject({ connected: true, tools: 3, lastError: null });
    expect(registry.get('notes__count_words')).toMatchObject({
      tier: 'auto',
      action: 'mcp.notes.count_words',
    });
    expect(registry.get('notes__wipe')).toMatchObject({ tier: 'critical', destructive: true });
    expect(registry.get('notes__post')?.tier).toBe('gated');
    expect(registry.get('notes__count_words')?.resource({})).toBe('mcp:notes/count_words');
  });

  it('applies overrides from config, including turning a tool off', async () => {
    const { registry } = await connected({ tools: { post: { tier: 'critical' }, wipe: { disabled: true } } });
    expect(registry.get('notes__post')?.tier).toBe('critical');
    expect(registry.get('notes__wipe')).toBeUndefined();
  });

  it('calls a tool and surfaces a tool error as a failure', async () => {
    const { registry } = await connected();
    const ctx = { idempotencyKey: 'k', signal: new AbortController().signal };
    expect(await registry.get('notes__count_words')?.execute({ text: 'one two three' }, ctx)).toBe('3');
    await expect(registry.get('notes__post')?.execute({}, ctx)).rejects.toThrow('quota exceeded');
  });

  it('removes a dropped server’s tools and reports it', async () => {
    const { registry, mcp, drop } = await connected();
    await drop();
    await new Promise((r) => setTimeout(r, 20));
    expect(registry.get('notes__count_words')).toBeUndefined();
    expect(mcp.status('notes')).toMatchObject({ connected: false, lastError: 'The connection closed' });
  });

  it('records a server that is switched off without connecting', async () => {
    const registry = new ToolRegistry();
    const mcp = new McpManager(registry, {
      transport: () => {
        throw new Error('should not connect');
      },
    });
    const h = await mcp.connect(spec({ enabled: false }));
    expect(h).toMatchObject({
      enabled: false,
      connected: false,
      lastError: 'Switched off in config/mcp.yaml',
    });
    await mcp.stop();
  });
});

describe('MCP safety', () => {
  it('gives a stdio server a minimal environment plus its own secrets, not Core’s', async () => {
    process.env.ANCILE_TEST_LEAK = 'core-only';
    try {
      const t = defaultTransport(spec({ command: 'node' }), { NOTES_TOKEN: 'secret' }) as unknown as {
        _serverParams: { env: Record<string, string> };
      };
      expect(t._serverParams.env.NOTES_TOKEN).toBe('secret');
      expect(t._serverParams.env.ANCILE_TEST_LEAK).toBeUndefined();
    } finally {
      delete process.env.ANCILE_TEST_LEAK;
    }
  });

  it('keeps tool names unique when they have to be cleaned or shortened', () => {
    expect(mcpToolName('notes', 'count_words')).toBe('notes__count_words');
    const a = mcpToolName('notes', 'a.b');
    const b = mcpToolName('notes', 'a/b');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^notes__a_b_[0-9a-f]{6}$/);
    const long1 = mcpToolName('server', `${'x'.repeat(80)}_one`);
    const long2 = mcpToolName('server', `${'x'.repeat(80)}_two`);
    expect(long1).not.toBe(long2);
    expect(long1.length).toBeLessThanOrEqual(64);
    // A clean name that is already taken by another server's tool.
    expect(mcpToolName('a__b', 'c', (n) => n === 'a__b__c')).toMatch(/^a__b__c_[0-9a-f]{6}$/);
  });

  it('registers nothing when the server is disconnected while it connects', async () => {
    const registry = new ToolRegistry();
    const s = server();
    let mcp: McpManager | undefined;
    mcp = new McpManager(registry, {
      transport: () => {
        const [a, b] = InMemoryTransport.createLinkedPair();
        void s.connect(b);
        // Settings → Tools switched it off a moment after the connect began.
        void mcp?.disconnect('notes');
        return a;
      },
    });
    await mcp.connect(spec());
    expect(registry.list()).toHaveLength(0);
    await s.close();
  });
});
