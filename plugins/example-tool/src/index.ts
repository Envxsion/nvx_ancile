/**
 * ------------------------------------------------------------------
 *  Title    |  Writing tools: an example Ancile plugin
 *  Ref      |  docs/plugins.md, config/mcp.yaml
 *  ID       |  plugin:example-tool
 * ------------------------------------------------------------------
 *  Purpose  |  Shows the whole shape of a tools plugin: two tools at
 *           |  different permission tiers, served over stdio MCP.
 *  How      |  defineTool() declares the action, tier and how the
 *           |  arguments become a resource URI. Ancile checks the
 *           |  permission on that URI before the handler ever runs, so
 *           |  the handler can assume it is allowed.
 *  Note     |  Enable in Settings → Tools, or set enabled: true for
 *           |  example-tool in config/mcp.yaml after `pnpm build`.
 * ------------------------------------------------------------------
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defineTool, toMcpRegistration } from '@nvx/plugin-sdk';
import { z } from 'zod';

const WORKSPACE = process.env.ANCILE_WORKSPACE_ROOT ?? '/workspace';

// AUTO: read-only, no side effects. Never asks.
const wordCount = defineTool({
  name: 'word_count',
  description: 'Count words, sentences and estimated reading time in a piece of text.',
  input: z.object({ text: z.string().max(200_000) }),
  action: 'text.count',
  tier: 'auto',
  resource: () => 'text:inline',
  handler: async ({ text }) => {
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const sentences = (text.match(/[.!?]+(\s|$)/g) ?? []).length;
    return { words, sentences, reading_minutes: Math.max(1, Math.round(words / 230)) };
  },
});

// GATED: writes a file. Ancile asks the first time per pattern
// (e.g. fs:/workspace/snippets/**) and remembers the answer.
const saveSnippet = defineTool({
  name: 'save_snippet',
  description: 'Save a short piece of text as a markdown file in the workspace snippets folder.',
  input: z.object({
    name: z.string().regex(/^[a-z0-9-]{1,60}$/, 'lowercase letters, digits and dashes only'),
    content: z.string().max(50_000),
  }),
  action: 'fs.write',
  tier: 'gated',
  resource: ({ name }) => `fs:${WORKSPACE}/snippets/${name}.md`,
  handler: async ({ name, content }, ctx) => {
    const dir = join(WORKSPACE, 'snippets');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${name}.md`);
    // Writing the same content twice is harmless, so the idempotency key is
    // only recorded, not enforced. A tool that sends or charges must enforce it.
    await writeFile(path, content, 'utf8');
    return { saved: path, bytes: Buffer.byteLength(content), idempotency_key: ctx.idempotencyKey ?? null };
  },
});

const server = new McpServer({ name: 'example-tool', version: '0.1.0' });
for (const def of [wordCount, saveSnippet] as Array<Parameters<typeof toMcpRegistration>[0]>) {
  const reg = toMcpRegistration(def);
  // The SDK's registerTool accepts a zod object shape or schema depending on
  // version; TODO(phase-2): pin once Core's MCP adapter settles on SDK v1.x vs v2.
  server.registerTool(reg.name, reg.config as never, reg.handler as never);
}

await server.connect(new StdioServerTransport());
