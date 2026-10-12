/**
 * NVX Ancile's MCP server for live Claude Code sessions (/mcp/claude):
 * a token per thread, the notebook's sources as search and read, passages
 * numbered by the live turn, hosted tools behind the gate.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { SearchHit, SearchResponse } from '@nvx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeMcpEndpoint, type Passage, threadToken, tokenThread } from '../../src/claudecode/mcp-server';
import { CLAUDE_CODE_PRINCIPAL } from '../../src/claudecode/permission-map';
import { LabPasses } from '../../src/lab/hosted';
import { BuiltinPolicy } from '../../src/permissions/cedar';
import { createGate } from '../../src/permissions/gate';
import { MemoryPermissionStore } from '../../src/permissions/store';
import { ToolRegistry } from '../../src/tools/registry';

const SECRET = 'k'.repeat(43);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const hit = (n: number): SearchHit =>
  ({
    chunk_id: `chk_${n}`,
    source_id: `src_${n}`,
    source_title: `Source ${n}`,
    text: `Passage ${n}.`,
    char_start: 0,
    char_end: 10,
    page: n,
    heading_path: ['Intro'],
    kind: 'chunk',
    score: 1,
    rerank_score: null,
    ranks: {},
  }) as unknown as SearchHit;

function setup(
  opts: { passages?: (t: string, h: SearchHit[]) => Passage[] | null; hits?: SearchHit[] } = {},
) {
  const registry = new ToolRegistry();
  let ran = 0;
  registry.register({
    name: 'github__create_issue',
    description: 'Create an issue',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    action: 'mcp.github.create_issue',
    tier: 'gated',
    destructive: false,
    source: { kind: 'mcp', server: 'github' } as never,
    resource: () => 'mcp:github/create_issue',
    execute: async () => {
      ran++;
      return 'created #1';
    },
  });
  const perms = new MemoryPermissionStore();
  const passes = new LabPasses();
  const searched: { notebookId: string; query: string; sourceIds?: string[] }[] = [];
  const endpoint = new ClaudeMcpEndpoint({
    secret: SECRET,
    registry,
    gate: createGate({ policy: new BuiltinPolicy(), store: perms, workspaceRoot: '/workspace' }),
    passes,
    userId: 'usr_1',
    workspaceId: 'wsp_1',
    version: 'test',
    thread: async (id) =>
      id === 'thr_1'
        ? { notebookId: 'nbk_1', notebookTitle: 'app' }
        : id === 'thr_2'
          ? { notebookId: null, notebookTitle: null }
          : null,
    search: async (q) => {
      searched.push(q);
      return { hits: opts.hits ?? [hit(1), hit(2)] } as unknown as SearchResponse;
    },
    notebookSources: async () => [{ id: 'src_1', title: 'Source 1' }],
    sourceContent: async () => ({ markdown: 'x'.repeat(30_000) }),
    memorySearch: async () => [{ path: 'people/me.md', text: 'Prefers British spelling', score: 1 }],
    ...(opts.passages && { passages: opts.passages }),
    sourceIdsOf: () => ['src_1'],
  });
  return { endpoint, perms, passes, searched, ran: () => ran };
}

async function clientOf(handle: (req: Request) => Promise<Response>, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL('http://core.test/mcp/claude'), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (input, init) => handle(new Request(input, init)),
  });
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await client.connect(transport);
  cleanups.push(() => client.close().catch(() => undefined));
  return client;
}

const textOf = (r: unknown) =>
  ((r as { content: { type: string; text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('');

describe('the MCP server for Claude Code sessions', () => {
  it('takes only a token made for a thread', async () => {
    const token = threadToken(SECRET, 'thr_1');
    expect(tokenThread(SECRET, token)).toBe('thr_1');
    expect(tokenThread(SECRET, `thr_2.${token.split('.')[1]}`)).toBeNull();
    expect(tokenThread('other', token)).toBeNull();
    const { endpoint } = setup();
    const res = await endpoint.handle(
      new Request('http://core.test/mcp/claude', {
        method: 'POST',
        headers: { authorization: 'Bearer nope' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('lists the knowledge tools and the hosted ones', async () => {
    const { endpoint } = setup();
    const client = await clientOf(endpoint.handle, threadToken(SECRET, 'thr_1'));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'github__create_issue',
      'memory_search',
      'read_source',
      'search',
    ]);
  });

  it("searches the thread's notebook, numbered by the live turn, with source and chunk ids", async () => {
    const { endpoint, searched } = setup({
      passages: (_t, hits) => hits.map((h, i) => ({ marker: i + 4, hit: h })),
    });
    const client = await clientOf(endpoint.handle, threadToken(SECRET, 'thr_1'));
    const out = textOf(await client.callTool({ name: 'search', arguments: { query: 'tokens' } }));
    // Asks for more than 8, so 8 remain after no source may give more than 4.
    expect(searched[0]).toEqual({ notebookId: 'nbk_1', query: 'tokens', k: 24, sourceIds: ['src_1'] });
    expect(out).toContain('[4] Source 1 · page 1 · Intro (source src_1, chunk chk_1)');
    expect(out).toContain('[5] Source 2');
  });

  it('lets no one source give more than four passages to a search', async () => {
    const big = (n: number): SearchHit => ({ ...hit(n), source_id: 'src_big', source_title: 'Repo dump' });
    const { endpoint } = setup({ hits: [big(1), big(2), big(3), big(4), big(5), big(6), hit(7), big(8)] });
    const client = await clientOf(endpoint.handle, threadToken(SECRET, 'thr_1'));
    const out = textOf(await client.callTool({ name: 'search', arguments: { query: 'tokens', k: 6 } }));
    expect(out.match(/\(source src_big,/g)).toHaveLength(4);
    expect(out).toContain('(source src_7, chunk chk_7)');
    expect(out).not.toContain('chunk chk_5)');
  });

  it('reads a source of the notebook a part at a time, and no other source', async () => {
    const { endpoint } = setup();
    const client = await clientOf(endpoint.handle, threadToken(SECRET, 'thr_1'));
    const part = textOf(await client.callTool({ name: 'read_source', arguments: { source_id: 'src_1' } }));
    expect(part).toMatch(/^Characters 0–20,000 of 30,000 \(read on with offset 20000\)/);
    const other = await client.callTool({ name: 'read_source', arguments: { source_id: 'src_9' } });
    expect(other.isError).toBe(true);
    const lone = await clientOf(endpoint.handle, threadToken(SECRET, 'thr_2'));
    expect((await lone.callTool({ name: 'search', arguments: { query: 'x' } })).isError).toBe(true);
  });

  it('runs a hosted tool only on a grant or on the pass an approval left', async () => {
    const { endpoint, passes, perms, ran } = setup();
    const client = await clientOf(endpoint.handle, threadToken(SECRET, 'thr_1'));
    const asked = await client.callTool({ name: 'github__create_issue', arguments: { title: 'x' } });
    expect(asked.isError).toBe(true);
    expect(textOf(asked)).toMatch(/approval/);
    passes.grant('github__create_issue');
    expect(textOf(await client.callTool({ name: 'github__create_issue', arguments: { title: 'x' } }))).toBe(
      'created #1',
    );
    perms.createGrant({
      userId: 'usr_1',
      principal: CLAUDE_CODE_PRINCIPAL,
      actionPattern: 'mcp.github.*',
      resourcePattern: 'mcp:github/**',
      effect: 'deny',
      scope: 'always',
      scopeRef: null,
      expiresAt: null,
      fromApprovalId: null,
    });
    passes.grant('github__create_issue');
    const denied = await client.callTool({ name: 'github__create_issue', arguments: { title: 'x' } });
    expect(textOf(denied)).toMatch(/^Not allowed/);
    expect(ran()).toBe(1);
  });
});
