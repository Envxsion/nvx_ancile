# Configuration

Ancile is configured in two places:

- **`.env`:** how the services run (ports, database, secrets, retention). Read at boot.
- **`config/*.yaml` and `config/policies/*.cedar`:** how Ancile behaves (models, routing, tools, memory, automations). Written by the setup and Settings screens. Hand-editing is fine. Changes are picked up live, and invalid files are rejected with the exact key.

Both are validated by schemas in `packages/contracts/src/config.ts`, and by each service's `env.ts` / `settings.py`.

## Environment variables

### Core

| Variable | Default | Meaning |
|---|---|---|
| `ANCILE_HOST` | `127.0.0.1` | Bind address. A non-loopback address requires `ANCILE_PASSPHRASE_REQUIRED=true` (the boot test enforces this). |
| `ANCILE_PORT` | `7700` | Core API, and the built Cockpit. |
| `ANCILE_PUBLIC_URL` | `http://localhost:7700` | The URL the browser uses: cookies, CORS, OAuth callbacks. |
| `ANCILE_SECRET_KEY` | none (required) | 32 random bytes, base64. Encrypts secrets at rest. |
| `ANCILE_PASSPHRASE_REQUIRED` | `false` | Require a passphrase to open the Cockpit. |
| `ANCILE_DATA_DIR` | `./data` | Memory repo, uploads, models cache, backups, exports. |
| `NODE_ENV` | `development` | `test` enables the fake provider and the `/__test` endpoints. |
| `ANCILE_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn` or `error`. |
| `ANCILE_BOOT_TESTS` | `strict` | `strict` blocks startup on failure, `warn` logs and continues, `off` skips. |

### Database

| Variable | Default | Meaning |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `ancile` / (generated) / `ancile` | Used by the compose Postgres. |
| `POSTGRES_PORT` | `5433` | Host port. 5433 avoids clashing with a local Postgres. |
| `DATABASE_URL` | none (required) | Connection string used by every service. |
| `DATABASE_POOL_MAX` | `40` (Core) | Pool size per service. Core's is larger: a burst of answers reads and writes in parallel. |

### Agent engine and integrations

```dotenv
# --- Agent engine (opencode fork, lab lane) ---
AGENT_ENGINE_URL=http://localhost:7730
AGENT_ENGINE_PORT=7730
# Shared secret between Core and the engine.
AGENT_ENGINE_TOKEN=
# The only directory tree the engine may work in. Each lab gets a subfolder.
AGENT_WORKSPACE_ROOT=./data/labs
# none | sandbox-runtime | docker-gvisor
AGENT_SANDBOX=sandbox-runtime

# --- Integrations (each behind a compose profile; empty = disabled) ---
RESEARCH_URL=        # gpt-researcher, profile "research"
CRAWL4AI_URL=        # Crawl4AI, profile "crawl"
DOCLING_SERVE_URL=   # docling-serve, profile "docling"
SPEECH_URL=          # Speaches STT/TTS, profile "speech"
```

Secrets at rest (provider keys, tokens) are encrypted with AES-256-GCM under `ANCILE_SECRET_KEY`.

### Knowledge

| Variable | Default | Meaning |
|---|---|---|
| `KNOWLEDGE_URL` / `KNOWLEDGE_PORT` | `http://localhost:7710` / `7710` | |
| `ANCILE_SERVICE_TOKEN` | none (required) | Shared secret between Core and Knowledge. |
| `KNOWLEDGE_EMBED_MODEL` | `BAAI/bge-small-en-v1.5` | Local CPU embedder. Changing it re-embeds in the background. |
| `KNOWLEDGE_RERANK_MODEL` | `BAAI/bge-reranker-v2-m3` | Local cross-encoder. |
| `KNOWLEDGE_MODEL_CACHE` | `./data/models` | Model weights cache. |
| `KNOWLEDGE_USE_DOCLING` | `true` | Layout-aware PDF parsing: slower, much better tables. |
| `KNOWLEDGE_OCR` | `false` | OCR for scans and images. |
| `KNOWLEDGE_CHUNK_TOKENS` / `KNOWLEDGE_CHUNK_OVERLAP` | `512` / `64` | Chunking. |
| `KNOWLEDGE_CONTEXTUAL_CHUNKS` | `true` | Add a short LLM-written context blurb to each chunk before indexing. |
| `SEARXNG_URL` | empty | Web search for evidence. Empty disables it. |

### Controller

| Variable | Default | Meaning |
|---|---|---|
| `CONTROLLER_URL` / `CONTROLLER_PORT` | `http://localhost:7720` / `7720` | Leave `CONTROLLER_URL` empty to run without remote compute. |
| `CONTROLLER_TOKEN` | none (required with a Controller) | Core → Controller auth. |
| `RUNPOD_API_KEY` | empty | Pod read/write scope. Used only by the Controller. Optional: Admin → Compute → Connect RunPod saves the key in the app instead. Empty and not connected: sample nodes. |
| `RUNPOD_API_BASE` | `https://api.runpod.io` | REST v2. v1 is retired on 15 Nov 2026. |
| `CONTROLLER_COST_CAP_USD` | `150` | Default hard monthly cap across nodes. |
| `CONTROLLER_QUEUE_DEADLINE_S` | `240` | How long a request waits for a waking node. |
| `CONTROLLER_NODE_TOKEN` | empty | The shared key between the Controller and its nodes: the Controller sends it to each node's model server, and nodes use it for heartbeats. A pod you set up by hand needs the same value as `ANCILE_NODE_API_KEY` and `CONTROLLER_NODE_TOKEN`; pods created from the app get it automatically. Creating a pod from the app without it fails with `node.needs_token`. |

### Providers

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` and `OPENROUTER_API_KEY` are imported into the secrets store on first boot. `OLLAMA_BASE_URL` defaults to `http://localhost:11434`.

### API keys {#api-keys}

**Settings → API keys** is where every credential is added, replaced and removed without editing a file. Each value is checked before it is saved, encrypted with `ANCILE_SECRET_KEY`, and never sent back to the browser: a row shows only **Saved · ends in 4f2a** (the last four characters, and nothing for a value shorter than 12) or **Not set**.

| Row | Environment variable | Checked by |
|---|---|---|
| Anthropic, OpenAI, Google, OpenRouter | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENROUTER_API_KEY` | One short request to the provider's cheapest configured model (the setup test). A first key switches that provider's models on; a replacement leaves your choices alone. |
| RunPod | `RUNPOD_API_KEY` | The Controller, which asks RunPod before Core saves it (the same path as Admin → Compute → Connect RunPod). Unavailable when Core has no `CONTROLLER_URL`. |
| Hugging Face | `HF_TOKEN` | Hugging Face's `whoami`. For gated models on GPU nodes. |
| GitHub | `GITHUB_TOKEN` | GitHub's `/user`. Used by Repositories when the `gh` command is not signed in. |
| Memory backup | `ANCILE_MEMORY_REMOTE` | Its shape only: an address git can push to (`git@host:path`, `https://`, `ssh://`, `file://`). Read by the nightly memory backup each time it runs, so a change needs no restart. |

**The environment wins.** When one of these variables is set where Core starts, Core uses it instead of the saved value, and its row says **Set in the environment** and is read-only. Change or remove the variable and restart. The routes are `GET /api/v1/credentials`, `PUT /api/v1/credentials/{id}` with `{ "value": "…" }`, and `DELETE /api/v1/credentials/{id}`, behind the same auth as every other route; errors are listed under [Credentials](errors.md#credentials).

The Hugging Face token is stored and checked here, but is not yet handed to new GPU nodes by the Controller; until then set `HF_TOKEN` on the pod as well.

### Self-healing, memory, observability, licence

| Variable | Default | Meaning |
|---|---|---|
| `ANCILE_RESTART_ADAPTER` | `none` | `none`, `process` or `docker`. `docker` needs the socket mounted (opt-in). |
| `ANCILE_RESTART_AFTER_FAILURES` | `3` | Consecutive failed probes before an automatic restart. |
| `ANCILE_HEALTH_INTERVAL_S` | `15` | Probe interval. |
| `ANCILE_APPROVAL_TTL_AUTOMATION_S` | `86400` | Expiry for approvals raised by unattended automations. |
| `ANCILE_MEMORY_REMOTE` | empty | Git remote for memory backups. Can also be set in Settings → API keys; this variable wins. |
| `ANCILE_MEMORY_AUTHOR_NAME` / `_EMAIL` | `NVX Ancile` / `memory@ancile.local` | Author of automatic memory commits. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | empty | Optional OTLP export, for example to Phoenix. |
| `ANCILE_LOG_RETENTION_DAYS` / `_SPAN_` / `_RUN_EVENT_` | `14` / `30` / `7` | Retention. |
| `NVX_TIER` | empty | Running from source only: `free` never loads Pro; `pro` loads it from `pro/`. Empty: Pro when `pro/` is present, free otherwise. Release builds ignore it: their edition is what was bundled. |
| `NVX_LICENSE_URL` | `https://ancile.nvx.sh/api/license` | Licence activation and the daily refresh. Tokens are checked offline. |
| `NVX_LICENSE_KEYS` | nvx.sh's public keys | Licence public keys, `{"kid":"<base64url Ed25519 key>"}` or `kid:key,kid:key`. Running from source only, to test with your own signing key. Release builds ignore it and trust only the keys built in (`OFFICIAL_LICENSE_KEYS`). |
| `NVX_TELEMETRY_URL` | official builds: `https://ancile.nvx.sh/api/telemetry`; from source: empty | Anonymous usage statistics endpoint, `https://` only. Nothing is sent unless you turn statistics on in Settings → Privacy. Running from source with this empty, nothing is ever sent. See [telemetry](telemetry.md). |

## config/ files

### models

`config/models.yaml` lists every model. The fields:

| Key | Example | Notes |
|---|---|---|
| `id` | `anthropic/claude-sonnet-5-5` | `provider/model`, lowercase provider. Referenced by routing. |
| `provider` | `anthropic`, `openai`, `google`, `openai-compatible`, `controller`, `local` | Selects the Gateway adapter. |
| `provider_model` | `claude-sonnet-5-5` | The id the provider expects. For `controller`, it's the route alias. |
| `display_name` | `Claude Sonnet 5.5` | Shown in the UI. |
| `via` | `direct` or `controller` | |
| `family` | `anthropic` | Fact-check verifiers prefer a different family from the generator. |
| `context_window`, `max_output` | `200000`, `64000` | Drive the context meter and compaction. |
| `capabilities` | `[tools, vision, reasoning, json, embeddings, rerank, audio]` | Used when switching models mid-thread. |
| `price` | `{input_per_mtok, output_per_mtok, cached_per_mtok}` | USD per million tokens; cost display and budgets. |
| `enabled` | `true` | |
| `base_url` | `http://localhost:11434/v1` | Any OpenAI-compatible endpoint. |
| `secret` | `ANTHROPIC_API_KEY` | Name in the secrets store. |

Example: adding a vLLM server you run yourself, without the Controller:

```yaml
  - id: lab/llama-4-70b
    provider: openai-compatible
    provider_model: meta-llama/Llama-4-70B-Instruct
    display_name: Llama 4 70B (lab box)
    family: llama
    context_window: 131072
    max_output: 8192
    capabilities: [tools, json]
    base_url: http://10.0.0.12:8000/v1
    secret: LAB_VLLM_KEY
```

### routing

`config/routing.yaml` maps task classes to fallback chains. See [self-healing.md](self-healing.md).

| Task class | Used for |
|---|---|
| `chat.default` | Normal turns |
| `chat.deep` | "Think harder", research synthesis |
| `utility` | Titles, tags, memory capture, summaries, claim extraction |
| `embed` / `rerank` | Knowledge |
| `factcheck.verify` | Claim verification. `prefer_different_family: true` keeps the verifier independent of the generator. |

`resilience` sets the retry (`base_ms`, `factor`, `cap_ms`, `max_attempts`) and breaker (`window_s`, `failure_rate`, `min_calls`, `consecutive`, `half_open_s`) defaults. `compute_wait_max_s` bounds waiting for a GPU node.

### tools

`preset`, `workspace_root`, and `tools.<namespace>.<action>: {tier, disabled, destructive}`. See [permissions.md](permissions.md).

### memory

`budget` (`share_of_context`, `max_tokens`), `capture` (`propose_all`, `auto_confident` or `off`), `remote`, and `types.<name>: {path, scope, priority, budget_share, auto_apply, top_k}`. See [memory.md](memory.md).

### mcp

`servers[]`, each with:
- `stdio`: `command`, `args`, `env_secrets`
- `http`: `url`, `oauth`

Both take `enabled` and per-tool `tools` overrides. See [plugins.md](plugins.md).

### panels

`panels[]: {id, title, placement: drawer|admin, plugin, entry, capabilities}`.

### Automations {#automations}

Every job: `enabled`, optional `cron`, `config`.

| Job | Config |
|---|---|
| `auto_title` | `after_turns` |
| `auto_tag_sources` | `max_tags` |
| `stale_sources` | `url_stale_after_days`, weekly cron |
| `tldr` | `min_turns` |
| `draft_autosave` | `server_every_s` |
| `cleanup` | `temp_max_age_h`, nightly cron |
| `memory_backup` | hourly cron, pushes only if a remote is set |
| `duplicate_sources` | `near_dup_threshold` |
| `branch_suggestions` | `drift_threshold` |
| `model_suggestions` | `min_calls` |
| `context_overflow_warn` | `warn_at`, `auto_compact_at` |
| `memory_capture` | none |
| `model_stats_rollup` | every 15 minutes |

### factcheck

`weights` (`support`, `agreement`, `retrieval`; these sum to 1), `thresholds` (`contradict`, `verified`), `web_search`. See [factcheck.md](factcheck.md).

## The offline model, the workspace and the lab

```bash
# The try-out models (Offline test model, Offline echo): answer without a key
# or a network, for trying NVX Ancile out and for tests. They don't use AI.
# `pnpm start` and the desktop app turn them on. The model switcher and
# pickers hide them once a real model is ready, unless Settings → Advanced →
# Show try-out models is on.
ANCILE_OFFLINE_MODELS=1

# Where the file tools and the lab work. Models see it as /workspace.
# Default: $ANCILE_DATA_DIR/workspace
# ANCILE_WORKSPACE_DIR=

# The built Cockpit that Core serves when NODE_ENV=production. The desktop
# app points it at its bundled copy. Default: apps/cockpit/dist
# ANCILE_COCKPIT_DIST=

# The lab's key to Core. Accepted for /internal/v1/openai/* (model calls)
# only. Generated into .ancile/secrets.json by `pnpm start`.
# AGENT_GATEWAY_TOKEN=
```

Provider keys (`ANTHROPIC_API_KEY` and the others) are copied into Core's encrypted store the first time Core sees them, and are read from the store after that. While the variable is still set, though, it wins over the saved key (see [API keys](#api-keys)); remove it from `.env` to manage the key in Settings → API keys.

## Requests, approvals and sources

```dotenv
# --- Core: request safety, approvals, the lab ---
# Extra origins allowed to write to /api/v1 (comma-separated). The Cockpit
# (localhost/127.0.0.1 on 7700 and 7701), ANCILE_PUBLIC_URL and the Tauri
# origins are always allowed.
ANCILE_ALLOWED_ORIGINS=
# An approval nobody answers expires after this many seconds (24 h).
ANCILE_APPROVAL_TTL_S=86400
# A lab run that has not finished after this many seconds is stopped (30 min).
ANCILE_LAB_TIMEOUT_S=1800
# Runs one Core executes at once (answers, fact-checks, lab runs). Most of a
# run is waiting on a provider, so this can be generous.
ANCILE_RUN_CONCURRENCY=64

# --- Knowledge: sources, ingestion, search ---
# Where originals and extracted text are kept (default <ANCILE_DATA_DIR>/knowledge).
KNOWLEDGE_DATA_DIR=
# Largest file that can be added as a source, and largest page fetched for a link.
KNOWLEDGE_MAX_UPLOAD_MB=200
KNOWLEDGE_MAX_FETCH_MB=50
# Let links point at private network addresses (off: blocks SSRF to your LAN).
KNOWLEDGE_ALLOW_PRIVATE_URLS=false
# Run the ingestion worker inside the knowledge service.
KNOWLEDGE_WORKER=true
# How often the stale check runs; each URL source is re-checked when it falls due.
KNOWLEDGE_STALE_CHECK_HOURS=6
# Allow downloading embedding and rerank weights on first use.
KNOWLEDGE_MODEL_DOWNLOAD=true
# Passages embedded per batch.
KNOWLEDGE_EMBED_BATCH=64
# The reranker; fastembed does not support bge-reranker-v2-m3.
KNOWLEDGE_RERANK_MODEL=Xenova/ms-marco-MiniLM-L-6-v2
```

## Remote compute

With none of the compute settings set, a development install shows two sample GPU nodes (no GPU, no cost) so Admin → Compute and the wake path can be tried end to end.

```dotenv
# --- Controller: GPU nodes ---
# runpod: pods in your RunPod account (needs RUNPOD_API_KEY)
# local:  OpenAI-compatible servers on your network (CONTROLLER_LOCAL_NODES)
# fake:   sample nodes. Also what runpod shows until a key is given here or
#         from Admin → Compute → Connect RunPod.
CONTROLLER_PROVIDER=runpod
RUNPOD_API_KEY=
# Machines on your network running Ollama, vLLM or LM Studio, as a JSON list:
# [{"name":"Desk 3090","url":"http://192.168.1.20:11434/v1","gpu":"RTX 3090"}]
CONTROLLER_LOCAL_NODES=
# How often node state is re-read from the provider, in seconds.
CONTROLLER_RECONCILE_S=30
# Where the Controller keeps nodes, operations, usage and rules (memory loses them on restart).
CONTROLLER_STORE=postgres
```

Core waits up to 5 minutes for a waking node before answering with the next model in the chain; "Use a cloud model instead" skips the wait at any time.

### Self-healing, logs, the MCP server and the licence

All are optional; the defaults suit `pnpm start`.

```dotenv
# --- Self-healing ---
# How failed services are brought back: process (the pnpm start runner; set
# automatically by pnpm start), docker (the Docker Engine API; mount the socket
# into Core), or none (tell you only).
ANCILE_RESTART_ADAPTER=
# Docker adapter only: the compose project prefix of the containers
# (nvx-ancile- gives nvx-ancile-knowledge-1 and so on). DOCKER_HOST is honoured.
ANCILE_DOCKER_PREFIX=nvx-ancile-

# --- Memory backup (the "Back up memory" automation) ---
# A git remote the memory folder is pushed to every hour. Empty: no backup.
ANCILE_MEMORY_REMOTE=

# --- Editions and statistics ---
# Empty: Pro when pro/ (a private submodule) is present, free otherwise.
NVX_TIER=
# Release builds set the licence keys and the statistics endpoint.
NVX_LICENSE_KEYS=
NVX_TELEMETRY_URL=
```

`pnpm start` also passes `ANCILE_CONTROL_URL` and `ANCILE_CONTROL_TOKEN` to Core (a loopback endpoint with a token made fresh each start, used to restart services); do not set them yourself. Retention for Admin → Logs and Traces uses `ANCILE_LOG_RETENTION_DAYS` (14), `ANCILE_SPAN_RETENTION_DAYS` (30) and `ANCILE_RUN_EVENT_RETENTION_DAYS` (7), applied nightly by the "Clean up old records" automation.

Apps that only speak MCP over stdio can use the bridge: `pnpm --filter @nvx/ancile-core exec tsx src/mcp/stdio.ts`, with `ANCILE_MCP_TOKEN` set to the token from Admin → Plugins (and `ANCILE_MCP_URL` if Core is not on `http://127.0.0.1:7700/mcp`).
