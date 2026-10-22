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

`resource()` and `action` say what the tool will touch, and the SDK uses them when your plugin checks a call itself (in its own tests, say). **Core does not call your `resource()`.** Your tool runs as an MCP server, and a JavaScript function cannot travel over MCP. Core checks every call to a tool from an MCP server, a plugin included, before your handler runs, on:

- the action `mcp.<server>.<tool>` and the resource `mcp:<server>/<tool>`, so a saved permission can name a server (`mcp.example-tool.*`) or one tool, but not a folder inside its arguments;
- the call's **real arguments**, which the floors read as data (a call that reaches NVX Ancile's own API, or names its install key, is refused) and which policies can read as `context.args`, the arguments as canonical JSON text. To limit a tool by what it is asked to do, write a policy ([permissions.md](permissions.md#policies)): `forbid (principal, action == Ancile::Action::"mcp.example-tool.save_snippet", resource) when { context.args like "*\"name\":\"secrets*" };`

TODO(phase-5b): let a plugin send its resource, so approving `fs:/workspace/snippets/**` once covers every later snippet. `toMcpRegistration` would put a URI template in `_meta` (`sh.nvx.ancile/resource`), and Core would fill it from the real arguments and check that, for the plugin's own tools only.

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
| `sh.nvx.ancile/action` | The permission action, for example `fs.write`. Sent for other clients; Core does not use it yet (it checks `mcp.<server>.<tool>`), though a change to it counts as a change to the tool (see below) |
| `sh.nvx.ancile/tier` | `auto`, `gated` or `critical` |
| `sh.nvx.ancile/destructive` | `true` or `false` |

Ancile reads that tier and the destructive flag as the tool's default (an override you set in the app still wins). On each call, Ancile sends `sh.nvx.ancile/idempotency_key` in the request's `_meta`. The SDK passes it to your handler as `ctx.idempotencyKey`.

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
- **Web address (SSE):** the older server-sent-events address some remote servers still use. It takes the same fields as http.

Tokens and keys go under **Secrets**: for a command they become environment variables, for a web address they become request headers (for example `Authorization` with `Bearer …`). Secrets are encrypted at rest and never shown again; the app only says whether each one is set. To change a secret, type a new value; leave it blank to keep the one stored.

The server connects as soon as you save, and its tools are available straight away, with no restart. The list shows whether each server is connecting, connected, switched off or failing (with the reason). Press Test to reconnect now. Changing how a server connects reconnects it; removing it takes its tools away and deletes its secrets.

Each tool has its own settings: change its tier (auto, gated or critical), go back to the server's own, or switch the tool off. A tool the server marks as destructive can never be auto. Changes apply at once. When a server adds or removes tools while connected, the list follows.

The GitHub preset (Add GitHub) sets up the official GitHub server this way; you can edit it afterwards like any other.

### Add server: the list of presets

Add server also opens a list of servers people reach for first: Filesystem, Playwright, Fetch, Git, Linear, Sentry, Supabase, Context7, Brave Search and Sequential thinking. Each was checked against the vendor's own documentation (the source is in `services/core/src/mcp/presets.ts`). Postgres, Slack, Notion and Vercel are not listed: their reference servers are archived or unsupported, or they only sign in with OAuth, so add them by hand if you accept that. Pick one and fill in only what it needs: a folder, a token. A token or password is stored encrypted under a name and never shown again. The server is added and connected at once, and the card says how the connection went. A server that runs with Node.js (npx) or uv (uvx) says what to install when that is missing. A server added while a thread is open is reached through the `mcp_call` bridge until the thread's next prompt epoch (docs/prompt-caching.md); nothing in the request being sent changes.

### Servers you already have in Claude Code

Admin → Plugins → From Claude Code lists the servers in your Claude Code. **Use in NVX Ancile** shows what would be copied (the command or address, the arguments, plain settings, and the names of the values that move into the encrypted store), asks for any `${VAR}` that has no value here, and copies it into NVX Ancile's own list. Claude Code keeps its own copy, unchanged; if Claude Code's settings change later, the list says so and offers to update the copy. claude.ai connectors are tied to your Claude account and cannot be copied; a server that only signs in through the browser needs an access token (use Add server). A server from your own Claude Code config can also be removed from Claude Code there.

Reading and changing Claude Code's servers happens only through its own `claude mcp` command (`get`, `add-json`, `remove`); NVX Ancile never edits `~/.claude.json` or `.mcp.json`. `claude mcp add-json` takes its config as an argument, so a secret you give it is visible in that process's argument list for the moment it runs.

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

### When a server changes its tools {#rug-pull}

A server you approved can change its tools later: add one, give an old one a new description or input schema that tells the model something else, or lower one's tier so that it runs without asking (a "rug pull"). NVX Ancile notices and asks you again, once.

- **Fingerprint.** The first list a server gives (when you add it, or on first start for a server in config/mcp.yaml) is the approved one. Each tool is hashed (SHA-256) over canonical JSON of its name, description, input schema, MCP annotations (`readOnlyHint`, `destructiveHint`, …) and Ancile's own `_meta` (`sh.nvx.ancile/tier`, `/action`, `/destructive`), with keys sorted, so the order a server lists things in does not matter. The server's fingerprint covers all its tools (`core.mcp_tool_approvals`, `services/core/src/mcp/guard.ts`). Other `_meta` keys and the per-call idempotency key are not part of it.
- **Versions.** The fingerprint has a version (`fingerprint_version`). Lists approved before the tiers and hints were included are version 1 (name, description and schema only) and are compared as they were made. The first time such a server lists tools that still match, the list is moved to version 2 silently, once: nothing is revoked, announced or asked again, so installed tools do not need approving again after an update. From then on a lowered tier or changed hint counts as a change. (A tier changed before that first match cannot be seen, because version 1 never recorded it.)
- **Checked every time.** On every connect, reconnect and `tools/list_changed`, the list is compared with the approved one.
- **On a change:** the server is marked "changed since approved"; its grants are revoked and Auto mode forgets its cached verdicts for the server's tools; you get one notification ("<server> changed its tools", Review the change) and an `mcp.tools_changed` event. Admin → Plugins shows what is new, changed and removed, with one button: Approve new tool list.
- **Until you approve:** new and changed tools are not offered to the model at all, and the gate refuses them (`via: "mcp_changed"`, code `mcp.tools_changed`), in every preset. Unchanged tools carry on, but ask again because their grants were revoked. A list that goes back to the approved one is approved again by itself.
- **Approving** sends the fingerprint you were shown (`POST /mcp/approvals/:key/approve`); if the server changed again meanwhile, nothing is approved (`mcp.tools_changed_again`).
- **Removing** a server, or renaming it, forgets its fingerprint: added again, its first list is the approved one.

Claude Code's own MCP servers (the ones in your Claude Code settings, used by a live session) get the same check. A session's start names its servers and their tools; the first list seen is approved, and a later session with a different list marks the server changed, so its new tools are refused at the same PreToolUse gate. Claude Code reports tool names only, so for its servers a new tool is caught but a changed description is not (`coverage: "names"`). They are listed in Admin → Plugins under "Claude Code's servers that changed".

TODO(phase-5): fingerprint Claude Code's servers' descriptions and schemas once the Agent SDK reports them.

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
