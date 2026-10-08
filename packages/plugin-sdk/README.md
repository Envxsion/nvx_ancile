# @nvx/plugin-sdk

Build plugins for NVX Ancile. There are three kinds:

| Kind | What it is |
|---|---|
| `tools` | An MCP server whose tools carry Ancile permission metadata: action, tier, resource, destructive |
| `memory-provider` | A `MemoryProvider` that stores memory somewhere other than the built-in git repository |
| `panel` | A drawer or admin panel. It runs in a sandboxed iframe and talks to the Cockpit over the panel bridge. |

A plugin is a folder in `plugins/` with an `ancile.plugin.json`. Plugins stay disabled until you enable them in **Settings → Plugins**. When you enable one, Ancile shows the permissions it asks for.

## A tool plugin

```ts
// plugins/word-tools/src/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defineTool, toMcpRegistration } from '@nvx/plugin-sdk';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const countWords = defineTool({
  name: 'count_words',
  description: 'Count the words in a file inside the workspace.',
  input: z.object({ path: z.string() }),
  action: 'fs.read',
  tier: 'auto',                       // read-only: never prompts
  resource: ({ path }) => `fs:${path}`, // the permission check runs on this, after normalisation
  handler: async ({ path }) => (await readFile(path, 'utf8')).split(/\s+/).filter(Boolean).length,
});

const server = new McpServer({ name: 'word-tools', version: '0.1.0' });
const { name, config, handler } = toMcpRegistration(countWords);
server.registerTool(name, config, handler);
await server.connect(new StdioServerTransport());
```

```json
// plugins/word-tools/ancile.plugin.json
{
  "id": "word-tools",
  "name": "Word tools",
  "version": "0.1.0",
  "kind": "tools",
  "entry": "dist/server.js",
  "description": "Count words in workspace files.",
  "tools": [{ "name": "count_words", "action": "fs.read", "tier": "auto" }]
}
```

### Rules the SDK enforces

- A `destructive` tool can never be `auto`. Ancile can't silently lower its floor either.
- `action` is `namespace.verb`, for example `fs.read`, `http.post` or `mcp.github.create_issue`.
- Ancile passes an idempotency key on every call as `ctx.idempotencyKey`. Tools with side effects should honour it. If a tool doesn't, a step interrupted mid-call is marked *uncertain*, and Ancile asks you before it retries.

## A panel

```ts
import { createPanelClient } from '@nvx/plugin-sdk/panel';

const host = createPanelClient();
host.onContext(({ theme }) => (document.documentElement.dataset.theme = theme));
const thread = await host.request({ kind: 'thread.get' }); // needs read:thread
```

The capabilities a panel may use are declared in `config/panels.yaml`. Any request outside them is refused by the host.
