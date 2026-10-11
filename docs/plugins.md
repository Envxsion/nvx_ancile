# Plugins

Ancile can be extended in four ways, most of them without writing code:

| To add | Do this | Code? |
|---|---|---|
| A model | Settings → Models, or `config/models.yaml` | No |
| An existing MCP server (GitHub, Slack, a database…) | Admin → Plugins, or `config/mcp.yaml` | No |
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
const count = toMcpRegistration(wordCount);
server.registerTool(count.name, count.config, count.handler);
const save = toMcpRegistration(saveSnippet);
server.registerTool(save.name, save.config, save.handler);
await server.connect(new StdioServerTransport());
```

Use the MCP SDK version Core uses, `@modelcontextprotocol/sdk` 1.32 or later in the 1.x line. Its `registerTool` takes the whole zod object as `inputSchema`, so the registration fits without casts.

`toMcpRegistration` sets the standard MCP hints:
- `readOnlyHint` for auto tools
- `destructiveHint` for critical or destructive ones

Other MCP clients understand those too. It also puts Ancile's extras under `_meta`, on each tool in `tools/list`:

| Key | Value |
|---|---|
| `sh.nvx.ancile/action` | The permission action, for example `fs.write` |
| `sh.nvx.ancile/tier` | `auto`, `gated` or `critical` |
| `sh.nvx.ancile/destructive` | `true` or `false` |

Ancile reads that tier as the tool's default (an override you set in the app still wins). On each call, Ancile sends `sh.nvx.ancile/idempotency_key` in the request's `_meta`. The SDK passes it to your handler as `ctx.idempotencyKey`.

#### Build it and test it

`plugins/example-tool` builds with tsup into one file, `dist/index.js`. The SDK is bundled in, and the MCP SDK and zod load from `node_modules`:

```bash
pnpm --filter @nvx/plugin-example-tool build   # writes dist/index.js
pnpm --filter @nvx/plugin-example-tool test    # builds, then runs it over stdio
```

The test starts `node dist/index.js` with the MCP SDK's own stdio client. It lists the tools, checks the `_meta` keys above, and calls both tools. Copy it as the starting point for your own plugin's tests.

The SDK itself, `packages/plugin-sdk`, builds with `pnpm --filter @nvx/plugin-sdk build` into `dist/`, with type definitions that need nothing from this repository. It is not published yet. Its README has a five-minute quick start.

### 4. Turn it on

```bash
pnpm --filter @nvx/plugin-example-tool build
```

Then add it in Admin → Plugins (command `node`, argument the path to `dist/index.js`), or set `enabled: true` for `example-tool` in `config/mcp.yaml`. Ask "how long would this take to read?" with some text, and the tool runs without asking. Ask it to save a snippet, and you'll be asked once.

## Using an existing MCP server

### From the app

Open Admin → Plugins and press Add server. Give it a name (lower-case letters, digits, `-` or `_`) and say how to reach it:

- **Command (stdio):** the program and its arguments, plus any environment variables it needs.
- **Web address (http):** the server's URL, plus any request headers.

Tokens and keys go under **Secrets**: for a command they become environment variables, for a web address they become request headers (for example `Authorization` with `Bearer …`). Secrets are encrypted at rest and never shown again; the app only says whether each one is set. To change a secret, type a new value; leave it blank to keep the one stored.

The server connects as soon as you save, and its tools are available straight away, with no restart. The list shows whether each server is connecting, connected, switched off or failing (with the reason). Press Test to reconnect now. Changing how a server connects reconnects it; removing it takes its tools away and deletes its secrets.

Each tool has its own settings: change its tier (auto, gated or critical), go back to the server's own, or switch the tool off. A tool the server marks as destructive can never be auto. Changes apply at once. When a server adds or removes tools while connected, the list follows.

The GitHub preset (Add GitHub) sets up the official GitHub server this way; you can edit it afterwards like any other.

### From config/mcp.yaml

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

Servers in this file show in Admin → Plugins as read-only: edit the file and restart to change or remove them. You can still change their tools' tiers or switch tools off in the app; those settings sit on top of the file's. If the file and the app both have a server with the same name, the one in the file is used.

With no override, a tool's tier comes from its MCP hints: read-only → auto, destructive → critical, anything else → gated. A tool built with `@nvx/plugin-sdk` brings its own tier. OAuth tokens are encrypted at rest.

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
