# @nvx/plugin-sdk

Build plugins for NVX Ancile. There are three kinds:

| Kind | What it is |
|---|---|
| `tools` | An MCP server whose tools carry Ancile permission metadata: action, tier, resource, destructive |
| `memory-provider` | A `MemoryProvider` that stores memory somewhere other than the built-in git repository |
| `panel` | A drawer or admin panel. It runs in a sandboxed iframe and talks to the Cockpit over the panel bridge. |

Licence: GPL-3.0-or-later. Not published to npm yet: inside this repository, depend on it as `"@nvx/plugin-sdk": "workspace:*"`.

## Quick start: your first tool

A tool plugin is a small MCP server. NVX Ancile starts it, lists its tools, and checks every call against your permissions before it reaches your code.

**1. Make a folder and add the packages.**

```bash
mkdir plugins/word-tools && cd plugins/word-tools
pnpm init
pnpm add @modelcontextprotocol/sdk@^1.32.0 zod@^4.1.0
pnpm add -D @nvx/plugin-sdk@workspace:* tsup typescript
```

Set `"type": "module"` in its `package.json`, and add `"build": "tsup src/index.ts --format esm --target node22"` to its scripts. tsup bundles development dependencies, so the SDK ends up inside `dist/index.js`, and `node` can run it from anywhere.

**2. Write the tool** in `src/index.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defineTool, toMcpRegistration } from '@nvx/plugin-sdk';
import { z } from 'zod';

const shout = defineTool({
  name: 'shout',
  description: 'Turn text into capital letters.',
  input: z.object({ text: z.string().max(10_000) }),
  action: 'text.transform', // the permission Ancile checks
  tier: 'auto',             // read-only: never asks
  resource: () => 'text:inline',
  handler: async ({ text }) => text.toUpperCase(),
});

const server = new McpServer({ name: 'word-tools', version: '0.1.0' });
const reg = toMcpRegistration(shout);
server.registerTool(reg.name, reg.config, reg.handler);
await server.connect(new StdioServerTransport());
```

**3. Build it and run it.**

```bash
pnpm build
node dist/index.js   # waits silently for MCP messages on stdin; Ctrl+C to stop
```

**4. Add it in NVX Ancile.** Go to **Admin → Plugins → Add server** and choose **Local command**:

| Field | Value |
|---|---|
| Name | `word-tools` |
| Command | `node` |
| Arguments | the full path to `plugins/word-tools/dist/index.js` |

Save it. Its tools appear at once, with the tier you gave them. Ask the assistant to shout something: an `auto` tool runs without asking, and a `gated` one asks you the first time.

`plugins/example-tool` is a complete version of this, with a gated tool that writes files and a test that runs the built server over stdio.

## Writing tools

```ts
const saveSnippet = defineTool({
  name: 'save_snippet',
  description: 'Save a short piece of text as a markdown file.',
  input: z.object({ name: z.string().regex(/^[a-z0-9-]{1,60}$/), content: z.string() }),
  action: 'fs.write',
  tier: 'gated',                                               // ask once per pattern
  resource: ({ name }) => `fs:/workspace/snippets/${name}.md`, // the check runs on this
  handler: async ({ name, content }, ctx) => {
    // Runs only after Ancile allowed the call. ctx.idempotencyKey is set by Ancile.
    …
  },
});
```

`resource()` turns the real arguments into the URI the permission check runs on, so a grant like `fs:/workspace/snippets/**` covers every later snippet.

`toMcpRegistration()` returns what `McpServer.registerTool` takes. It sets the standard MCP hints (`readOnlyHint` for auto, `destructiveHint` for critical or destructive), and puts Ancile's extras under `_meta`:

| Key | Value |
|---|---|
| `sh.nvx.ancile/action` | The permission action |
| `sh.nvx.ancile/tier` | `auto`, `gated` or `critical` |
| `sh.nvx.ancile/destructive` | `true` or `false` |

### Rules the SDK enforces

- A `destructive` tool can never be `auto`. Ancile can't silently lower its floor either.
- `action` is `namespace.verb`, for example `fs.read`, `http.post` or `mcp.github.create_issue`.
- Ancile passes an idempotency key on every call as `ctx.idempotencyKey`. Tools with side effects should honour it. If a tool doesn't, a step interrupted mid-call is marked *uncertain*, and Ancile asks you before it retries.

## The manifest

A plugin folder in this repository also carries an `ancile.plugin.json`:

```json
{
  "id": "word-tools",
  "name": "Word tools",
  "version": "0.1.0",
  "kind": "tools",
  "entry": "dist/index.js",
  "description": "Shout text.",
  "tools": [{ "name": "shout", "action": "text.transform", "tier": "auto" }]
}
```

`validateManifest()` says what is wrong with one, in words you can act on.

## A panel

```ts
import { createPanelClient } from '@nvx/plugin-sdk/panel';

const host = createPanelClient();
host.onContext(({ theme }) => (document.documentElement.dataset.theme = theme));
const thread = await host.request({ kind: 'thread.get' }); // needs read:thread
```

The capabilities a panel may use are declared in `config/panels.yaml`. Any request outside them is refused by the host.

## Building the SDK

```bash
pnpm --filter @nvx/plugin-sdk build   # dist/index.js, dist/panel.js and their .d.ts
pnpm --filter @nvx/plugin-sdk test
```

Inside this repository, packages import the SDK's TypeScript source. A packed copy (`pnpm pack`) uses `dist/` instead, through `publishConfig`. The contract code it needs is bundled in, so its only dependency is zod.
