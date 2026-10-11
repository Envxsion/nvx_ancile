/**
 * The example tool, run the way NVX Ancile runs it: `node dist/index.js`
 * over stdio, driven by the MCP SDK's own client. Its tools list with
 * Ancile's permission metadata under _meta, word_count answers, and
 * save_snippet receives the idempotency key Ancile sends.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ENTRY = resolve(import.meta.dirname, '../dist/index.js');
let client: Client;
let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ancile-example-tool-'));
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: { ...getDefaultEnvironment(), ANCILE_WORKSPACE_ROOT: workspace },
      stderr: 'pipe',
    }),
  );
});

afterAll(async () => {
  await client?.close();
  await rm(workspace, { recursive: true, force: true });
});

const textOf = (r: unknown) =>
  ((r as { content: { type: string; text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('');

describe('example tool over stdio', () => {
  it('lists both tools with their tier, action and hints', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['save_snippet', 'word_count']);
    const count = tools.find((t) => t.name === 'word_count');
    expect(count?._meta).toMatchObject({
      'sh.nvx.ancile/tier': 'auto',
      'sh.nvx.ancile/action': 'text.count',
      'sh.nvx.ancile/destructive': false,
    });
    expect(count?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(count?.inputSchema).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } });
    const save = tools.find((t) => t.name === 'save_snippet');
    expect(save?._meta).toMatchObject({ 'sh.nvx.ancile/tier': 'gated', 'sh.nvx.ancile/action': 'fs.write' });
    expect(save?.annotations).toMatchObject({ readOnlyHint: false });
  });

  it('counts words', async () => {
    const r = await client.callTool({
      name: 'word_count',
      arguments: { text: 'One small step. One giant leap!' },
    });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(textOf(r))).toEqual({ words: 6, sentences: 2, reading_minutes: 1 });
  });

  it('refuses arguments that do not match the schema', async () => {
    const r = await client.callTool({ name: 'word_count', arguments: { text: 42 } });
    expect(r.isError).toBe(true);
  });

  it('saves a snippet and sees the idempotency key Ancile sends', async () => {
    const r = await client.callTool({
      name: 'save_snippet',
      arguments: { name: 'hello', content: '# Hello' },
      _meta: { 'sh.nvx.ancile/idempotency_key': 'run_1:3' },
    });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(textOf(r)) as { saved: string; idempotency_key: string | null };
    expect(out.idempotency_key).toBe('run_1:3');
    expect(await readFile(join(workspace, 'snippets', 'hello.md'), 'utf8')).toBe('# Hello');
  });
});
