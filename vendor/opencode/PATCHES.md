# How NVX Ancile runs this fork

Upstream: [sst/opencode](https://github.com/sst/opencode) at `ecc4916b`, MIT (see `LICENSE`).

The roadmap planned five code patches. All five turned out to be possible through opencode's own configuration and HTTP API, so **the engine's source is unchanged**. That keeps upgrades a matter of moving the pin. The only edits to the tree are packaging: the root `package.json` is renamed `@nvx/ancile-agent-engine`, and its workspaces are narrowed to the 15 engine packages Ancile runs.

How it is started: `scripts/boot.mjs` runs `bun run ./src/index.ts serve --hostname 127.0.0.1 --port 7730` in `packages/opencode`, with the environment from `agentEnv()` in `scripts/runtime.mjs`.

| Planned patch | How it is done | Where |
|---|---|---|
| 1. Permission bridge to Core; CRITICAL never "always" | The config sets `permission: {"*": "ask"}`, so every tool call raises `permission.asked`. Core's event mirror answers each one through Core's permission gate, using the same grants, Cedar policies and tiers as chat tools. Allowed calls get `once`. Denied calls get `reject` with the reason, which the engine passes to the model. Anything else becomes an approval in Ancile's dialog, and the answer is relayed back. Core never sends `always`, so remembered permissions live only in Core. `question` is denied because nobody is at the engine's own prompt. | `services/core/src/lab/event-mirror.ts`, `permission-map.ts` |
| 2. Core-signed auth and a pinned workspace root | The server password (`OPENCODE_SERVER_PASSWORD`) is a per-install secret that only Core holds. Each thread's sessions are opened with `?directory=<workspace>/labs/<thread>`. Every path the engine reports is mapped back to `/workspace/labs/<thread>/…` before it is checked, so leaving that folder is a write outside the workspace and escalates to critical. | `scripts/runtime.mjs`, `lab/handler.ts` |
| 3. No autoupdate, share or models.dev fetch | These are switched off by environment flags: `OPENCODE_DISABLE_AUTOUPDATE`, `_SHARE`, `_MODELS_FETCH`, `_CLAUDE_CODE*`, `_EXTERNAL_SKILLS`, `_DEFAULT_PLUGINS`, `_EMBEDDED_WEB_UI` and `_LSP_DOWNLOAD`. The config also sets `share: "disabled"` and `autoupdate: false`. Engine state is kept in `data/agent` (XDG dirs). | `agentEnv()` |
| 4. Gateway as the only provider | `OPENCODE_CONFIG_CONTENT` defines one provider, `ancile`. It uses `@ai-sdk/openai-compatible` (bundled, so nothing is downloaded) pointed at Core's `/internal/v1/openai`. The config also sets `enabled_providers: ["ancile"]` and `OPENCODE_DISABLE_PROJECT_CONFIG=1`, so no project file can add another provider. The key is `AGENT_GATEWAY_TOKEN`, which Core accepts for model calls only. | `agentConfig()`, `services/core/src/app.ts` |
| 5. MCP config pushed from Core | Core registers MCP servers in its own tool registry, so chat sees them now. The lab can be given the same servers through the `mcp` key of the injected config, or through `POST /mcp` at runtime. TODO(phase-3): push `config/mcp.yaml` to the engine when a lab session opens. | `services/core/src/mcp/manager.ts` |

## Isolation

The engine runs commands that a model chose, so `agentEnv()` builds its environment from nothing:
- system basics: `PATH`, home and temp
- its server password
- the injected config
- the gateway token

It never sees the service token, `DATABASE_URL` or any provider key.

Known gap, TODO(phase-5): after a person approves one shell command, that command could call the engine's own API on localhost to answer later requests itself. Mitigations today:
- Shell commands are critical, so every command is shown and asked for.
- Core treats its own decision log as the record.

Planned: run lab shells in a sandbox without network access to the engine port, and flag any `permission.replied` that Core did not send.

## Undo

Opencode's own snapshots only track a git project. Core copies the lab folder before each run (`lab/snapshot.ts`), and "What the lab changed" and Undo work from that copy.

## Upgrading

1. Move the pin.
2. Re-run `bun install` in `vendor/opencode`.
3. Check that these still have the same shapes: `permission.asked`, `message.part.updated`, `message.part.delta`, `session.idle`, and `POST /permission/:id/reply`.
4. Run `pnpm test:e2e` with `E2E_BACKEND=1 E2E_LAB=1`.
