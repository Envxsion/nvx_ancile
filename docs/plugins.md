# Plugins

Ancile can be extended in four ways, most of them without writing code:

| To add | Do this | Code? |
|---|---|---|
| A model | Settings → Models, or `config/models.yaml` | No |
| An existing MCP server (GitHub, Slack, a database…) | Settings → Tools, or `config/mcp.yaml` | No |
| Your own tool | Write a small MCP server with `@nvx/plugin-sdk` | Yes, a few dozen lines |
| A memory backend | Implement `MemoryProvider` | Yes |
| A panel in the drawer or Admin | A web page in a plugin folder, plus `config/panels.yaml` | Yes, HTML/JS |

A plugin is a folder in `plugins/` with an `ancile.plugin.json` manifest. Plugins start disabled. When you enable one, Ancile shows what it asks for: the files and hosts it wants, and its tools with their tiers.

## Worked example: a tool plugin

`plugins/example-tool` adds two tools: `word_count` (auto, never asks) and `save_snippet` (gated, asks once per folder).

### 1. The manifest

```json
{
  "id": "example-tool",
  "name": "Writing tools",
  "version": "0.1.0",
  "kind": "tools",
  "entry": "dist/index.js",
  "description": "Counts words and reading time in text, and saves snippets to the workspace.",
  "requests": ["fs:/workspace/snippets/**"],
  "tools": [
    { "name": "word_count", "action": "text.count", "tier": "auto" },
    { "name": "save_snippet", "action": "fs.write", "tier": "gated" }
  ]
}
```

Validation rules:
- `id` is lowercase with dashes.
- A `destructive` tool can't be `auto`.
- A tools plugin declares at least one tool.

`validateManifest()` in the SDK reports problems in words, for example `tools.wipe: destructive tools cannot be tier "auto"`.

### 2. The tools

```ts
import { defineTool, toMcpRegistration } from '@nvx/plugin-sdk';
import { z } from 'zod';

const saveSnippet = defineTool({
  name: 'save_snippet',
  description: 'Save a short piece of text as a markdown file in the workspace snippets folder.',
  input: z.object({ name: z.string().regex(/^[a-z0-9-]{1,60}$/), content: z.string() }),
  action: 'fs.write',                                          // what permission is checked
  tier: 'gated',                                               // ask once per pattern
  resource: ({ name }) => `fs:/workspace/snippets/${name}.md`, // what it's checked against
  handler: async ({ name, content }, ctx) => {
    // Runs only after Ancile has allowed it. ctx.idempotencyKey is set for side effects.
    …
  },
});
```

`resource()` is the important part. Ancile checks the permission on the URI it returns, using the real arguments, before your handler runs. So the handler can assume it's allowed. Grants then match on patterns: approving `fs:/workspace/snippets/**` once covers every later snippet.

### 3. Serve it over MCP

```ts
const server = new McpServer({ name: 'example-tool', version: '0.1.0' });
for (const def of [wordCount, saveSnippet]) {
  const reg = toMcpRegistration(def);
  server.registerTool(reg.name, reg.config, reg.handler);
}
await server.connect(new StdioServerTransport());
```

`toMcpRegistration` sets the standard MCP hints:
- `readOnlyHint` for auto tools
- `destructiveHint` for critical or destructive ones

Other MCP clients understand those too. It also puts Ancile's action and tier under `_meta['sh.nvx.ancile/…']`.

### 4. Turn it on

```bash
pnpm --filter @nvx/plugin-example-tool build
```

Then enable it in Settings → Tools, or set `enabled: true` for `example-tool` in `config/mcp.yaml`. Ask "how long would this take to read?" with some text, and the tool runs without asking. Ask it to save a snippet, and you'll be asked once.

## Using an existing MCP server

```yaml
# config/mcp.yaml
servers:
  - name: github
    transport: http
    url: https://api.githubcopilot.com/mcp/
    oauth: true
    enabled: true
    tools:
      create_issue: { tier: gated }
      delete_repository: { disabled: true }
```

With no override, a tool's tier comes from its MCP hints: read-only → auto, destructive → critical, anything else → gated. OAuth tokens are encrypted at rest.

## Memory providers

Implement the `MemoryProvider` interface (`packages/plugin-sdk/src/memory.ts`): `list`, `read`, `write`, `search` and `history`, plus an optional `check`. Writes carry a `baseVersion`, and a provider that can't merge must throw `MemoryConflict`. The Cockpit then shows the side-by-side conflict view. `plugins/example-memory-provider` sketches one backed by an Obsidian vault folder, using content hashes as versions.

Core still builds its search index over whatever `list` and `read` return, so injection and capture work unchanged.

## Panels {#panels}

A panel is a web page served from your plugin folder, shown in a sandboxed iframe in the drawer or in Admin:

```yaml
# config/panels.yaml
panels:
  - id: word-stats
    title: Word stats
    placement: drawer
    plugin: example-tool
    entry: panel/index.html
    capabilities: [read:thread]
```

The panel talks to Ancile only through the `@nvx/plugin-sdk/panel` bridge (postMessage), and only with the capabilities listed: `read:thread`, `read:sources`, `read:memory`, `write:notes`, `invoke:tools`. Tool calls from a panel go through the same permission checks as any other.
