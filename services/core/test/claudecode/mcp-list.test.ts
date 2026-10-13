/**
 * Claude Code's own MCP servers, listed read-only: from Claude Code's
 * status report, from live sessions' init messages, else the names in its
 * config. Never a command, an address, an env value, a header or a token.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LiveBridge, LiveControlOp, LiveEvent } from '../../src/claudecode/bridge-protocol';
import {
  ClaudeCodeMcpList,
  serversFromConfig,
  serversFromInit,
  serversFromStatus,
} from '../../src/claudecode/mcp-list';
import { MemorySettings } from '../../src/settings';

const STATUS = [
  {
    name: 'claude.ai Vercel',
    status: 'connected',
    scope: 'claudeai',
    source: 'claudeai',
    tools: [{ name: 'a' }, { name: 'b' }],
    config: { type: 'claudeai-proxy', url: 'https://secret.example/x' },
  },
  {
    name: 'supabase',
    status: 'needs-auth',
    scope: 'user',
    config: { type: 'http', headers: { authorization: 'Bearer sk-live-123' } },
  },
  { name: 'plugin:design:linear', status: 'failed', scope: 'dynamic', source: 'plugin', error: 'boom' },
  { name: 'ancile', status: 'connected', source: 'sdk' },
  { name: 'repo-tools', status: 'connected', source: 'project', tools: [] },
];

function fakeBridge(list: () => unknown) {
  const calls: string[] = [];
  let listener: ((e: LiveEvent) => void) | null = null;
  const bridge = {
    async open() {
      calls.push('open');
      return { handle: 'h_own' };
    },
    async close(h: string) {
      calls.push(`close:${h}`);
    },
    async control(h: string, op: LiveControlOp) {
      calls.push(`${op}@${h}`);
      return list();
    },
    onEvent(fn: (e: LiveEvent) => void) {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  } as unknown as LiveBridge;
  return { bridge, calls, emit: (e: LiveEvent) => listener?.(e) };
}

describe("Claude Code's MCP servers", () => {
  it('keeps only a name, where it is set up, a status and a tool count', () => {
    const got = serversFromStatus(STATUS);
    expect(got).toEqual([
      { name: 'claude.ai Vercel', source: 'claudeai', status: 'connected', tools: 2 },
      { name: 'supabase', source: 'user', status: 'needs-auth', tools: null },
      { name: 'repo-tools', source: 'project', status: 'connected', tools: 0 },
      { name: 'plugin:design:linear', source: 'plugin', status: 'failed', tools: null },
    ]);
    expect(JSON.stringify(got)).not.toMatch(/secret|sk-live|Bearer|boom|https/);
  });

  it('reads an init message, and skips messages that are not one', () => {
    expect(serversFromInit({ type: 'assistant' })).toBeNull();
    expect(
      serversFromInit({
        type: 'system',
        subtype: 'init',
        tools: ['Read', 'mcp__supabase__query', 'mcp__supabase__list'],
        mcp_servers: [
          { name: 'supabase', status: 'connected' },
          { name: 'ancile', status: 'connected' },
        ],
      }),
    ).toEqual([{ name: 'supabase', source: 'other', status: 'connected', tools: 2 }]);
  });

  it("reads only server names from Claude Code's config files", async () => {
    const home = await mkdtemp(join(tmpdir(), 'cc-home-'));
    const folder = await mkdtemp(join(tmpdir(), 'cc-proj-'));
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'someone@example.com' },
        mcpServers: { vercel: { type: 'http', url: 'https://x', headers: { authorization: 'Bearer tok' } } },
        projects: { [folder]: { mcpServers: { localdb: { command: 'db', env: { PASSWORD: 'hunter2' } } } } },
      }),
    );
    await writeFile(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'docs' } } }));
    const got = await serversFromConfig(home, [folder]);
    expect(got).toEqual([
      { name: 'vercel', source: 'user', status: null, tools: null },
      { name: 'docs', source: 'project', status: null, tools: null },
      { name: 'localdb', source: 'local', status: null, tools: null },
    ]);
    expect(JSON.stringify(got)).not.toMatch(/example\.com|tok|hunter2|https/);
    expect(await serversFromConfig(join(home, 'missing'), [])).toEqual([]);
  });

  it('asks Claude Code from a quiet session on first view, then keeps the list', async () => {
    const fb = fakeBridge(() => STATUS);
    const t = Date.parse('2026-10-13T10:00:00Z');
    const list = new ClaudeCodeMcpList({
      settings: new MemorySettings(),
      bridge: fb.bridge,
      cli: async () => ({ path: '/bin/claude' }),
      env: async () => ({}),
      folders: async () => [],
      now: () => t,
    });
    const got = await list.get();
    expect(fb.calls).toEqual(['open', 'mcp_status@h_own', 'close:h_own']);
    expect(got).toMatchObject({ from: 'status', can_refresh: true });
    expect(got.servers.map((s) => s.name)).toContain('claude.ai Vercel');
    await list.get();
    expect(fb.calls).toHaveLength(3);
  });

  it("a live session's init updates statuses and adds servers, never removes one", async () => {
    const fb = fakeBridge(() => STATUS);
    const list = new ClaudeCodeMcpList({
      settings: new MemorySettings(),
      bridge: fb.bridge,
      cli: async () => ({ path: '/bin/claude' }),
      env: async () => ({}),
      folders: async () => [],
      ignoreHandle: (h) => h === 'h_model',
    });
    await list.get();
    list.watch();
    const init = (handle: string, servers: { name: string; status: string }[]) =>
      fb.emit({
        event: 'session.message',
        data: { handle, message: { type: 'system', subtype: 'init', tools: [], mcp_servers: servers } },
      } as unknown as LiveEvent);
    // Claude Code as a model loads none of your settings: its init says nothing about your servers.
    init('h_model', []);
    init('h_live', [{ name: 'supabase', status: 'connected' }]);
    await new Promise((r) => setTimeout(r, 10));
    const got = await list.get();
    expect(got.servers.find((s) => s.name === 'supabase')?.status).toBe('connected');
    expect(got.servers).toHaveLength(4);
  });

  it('falls back to the names in the config when Claude Code cannot be asked', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cc-home-'));
    await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { supabase: {} } }));
    const fb = fakeBridge(() => STATUS);
    const list = new ClaudeCodeMcpList({
      settings: new MemorySettings(),
      bridge: fb.bridge,
      cli: async () => {
        throw new Error('not installed');
      },
      env: async () => ({}),
      folders: async () => [],
      home,
    });
    expect(await list.get()).toEqual({
      servers: [{ name: 'supabase', source: 'user', status: null, tools: null }],
      from: 'config',
      updated_at: null,
      can_refresh: false,
    });
    expect(fb.calls).toEqual([]);
  });
});
