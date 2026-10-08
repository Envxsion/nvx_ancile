# Getting started

This guide takes you from a fresh clone to your first answer that cites your own sources. It takes about ten minutes, most of it the first `pnpm start` downloading embedded Postgres and the embedding model. You don't need Docker.

## 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node | 22.12+ | Core, the Controller and the Cockpit |
| pnpm | 10+ (11 recommended) | Workspace packages: `corepack enable` |
| uv | any recent | The Python Knowledge service |
| Docker | optional | Only to run everything in containers instead |
| git | any | Memory is a git repository |

Check them all at once:

```bash
pnpm doctor
```

Each problem comes with a fix, for example:

```
  ✗ uv not found
    Install uv: https://docs.astral.sh/uv/getting-started/installation/
```

## 2. Configure

```bash
cp .env.example .env
node scripts/gen-keys.mjs --write
```

`gen-keys` fills every empty secret in `.env`:
- `ANCILE_SECRET_KEY`, which encrypts your provider keys at rest
- the service tokens
- a random Postgres password (`POSTGRES_PASSWORD`). `DATABASE_URL` can stay empty: `pnpm start` builds it from the `POSTGRES_*` values.

It never overwrites a value you've set.

**Back up `ANCILE_SECRET_KEY`.** Without it you'd have to re-enter your provider keys. Nothing else is lost.

You don't need to put model API keys in `.env`; the setup screens ask for them. If you do put them there, they're imported into the encrypted store on first boot.

## 3. Install and boot

```bash
pnpm i
uv sync --project services/knowledge
pnpm start
```

`pnpm start` does the same thing every time:

1. Starts embedded Postgres with pgvector ([pg0](https://github.com/vectorize-io/pg0), downloaded into `.ancile/` the first time) on port 5433, and waits for it. Its data lives in `data/pg`.
2. Runs each service's migrations.
3. Runs each service's **boot tests**, in dependency order. If one fails, startup stops with the reason and the fix:
   ```
   ✗ core 2.1s
       memory repository: data/memory is not a git repository
       fix: Move data/memory aside; it is recreated from memory-template/ on the next boot. See docs/runbooks/restore-backup.md to bring the old one back.
   ```
4. Starts the Controller, Knowledge, Core and the Cockpit with hot reload, with coloured prefixes on their logs.

`pnpm stop` stops everything, Postgres included. Your data stays in `data/`.

Open **http://localhost:7701** (dev) or **http://localhost:7700** (built).

## 4. First run

The setup screens walk you through:

1. **Models.**
   - Paste a key for any provider, then press **Test**. You'll see the latency and the model list.
   - If Ollama is running locally, it's detected for you.
   - If you run the Controller with a GPU node, add its URL here. You can skip this entirely.
2. **Permissions.** Choose how often Ancile asks before acting:
   - **Careful** asks before every write.
   - **Balanced** asks once per kind of write, then remembers. Recommended.
   - **Hands-off** only asks for things that can't be undone.
3. **Memory.** Choose whether Ancile can remember your preferences on its own, when it's confident, or should always ask first.
4. **First notebook.** Name it and drop in a few files or paste a link. You'll see each one go through extracting, enriching and embedding, with counts.
5. **Shortcuts.** Five keys worth learning now. Press `Ctrl K` (`⌘ K` on a Mac) to try the palette.

Not sure a shortcut works? Press `?`, then **Test a key**: it shows what the page received and what the key does. In a browser a few keys never reach the page (`Ctrl N`, `Ctrl T`, `Ctrl W`), and some extensions take others. Single-letter keys work when you are not typing: press `Esc` to leave the composer first.

In Opera, **Browser-safe keys** (Settings → Keyboard) is on automatically: zoom moves to `Alt =`, `Alt -` and `Alt 0`, search to `g /`, and Run in the lab to `Shift X`, because Opera keeps the usual keys for itself. The shortcuts sheet marks any key your browser may keep.

## 5. Ask something grounded

In your notebook, ask a question your sources can answer. The reply cites them like `[1]`. Click a citation and the source opens on the right, scrolled to the exact passage and highlighted.

Then try (with the reply selected, not the composer):
- `f` on the reply to fact-check it claim by claim
- `w` to see why the AI said it: memory used, sources retrieved, the model and any fallbacks
- `b` to branch the conversation from that message

## Route messages through a flow

A flow decides which model answers: a router reads the request and sends it to a specialist, a manager hands parts to workers, and so on. Open a notebook's **Flow** tab, start from a template, and press **Try** to run it against a sample message without saving. See [flows](flows.md), and [models](models.md) for adding OpenRouter, your own server or a RunPod node.

## See it with sample data

To see what a lived-in workspace feels like, fill it with a sample world while the stack is running:

```bash
pnpm seed          # add the sample world (re-running refreshes it)
pnpm seed --reset  # take it all out again
```

It adds four notebooks (a product launch, a heat pump retrofit, a novel draft and a tax year) with real, searchable sources, and a dozen threads over the last three weeks. Several threads are trees: an edited question, answers regenerated by different models, named branches, a merged draft and a compacted long thread. Answers cite their sources, some are fact-checked (one with a contradicted claim), memory has preferences, notebook files, lessons and two suggestions in the inbox, and one request is waiting for your approval.

Everything it creates is marked, so `--reset` removes only that: your own threads, notebooks, sources and memory entries are left exactly as they were. Memory files the sample created are deleted in their own commit, so History can still bring them back.

## Running the browser tests

The backend specs create threads, sources and approvals, so they run against a test profile with its own ports (everything +100: Cockpit on 7801, Core on 7800), its own database (`ancile_e2e`, on the same Postgres server) and its own data folder (`data/e2e`). It runs beside your everyday stack, so there is nothing to stop first:

```bash
pnpm start:e2e                 # the test profile, beside pnpm start
pnpm seed --e2e                # optional: the sample world, in the test profile
E2E_BACKEND=1 pnpm test:e2e    # refuses to run against your everyday stack
pnpm stop:e2e                  # stops only the test stack
```

`pnpm stop` stops both stacks and Postgres. Set `E2E_ALLOW_DEV_DB=1` (with `E2E_BASE_URL=http://localhost:7701`) only if you mean the tests to write into your own workspace.

## Running everything in containers (optional)

If you would rather not install Node, uv and Python:

```bash
docker compose up -d                          # Postgres, Knowledge, Controller, Core
docker compose --profile search up -d         # + SearXNG, for web evidence in fact-checks
docker compose --profile observability up -d  # + Phoenix trace explorer on :6006
```

## When something goes wrong

- `pnpm doctor` checks the environment.
- Admin → **Diagnostics** runs a full health check from inside the app, with a fix beside each failure.
- [Runbooks](runbooks/) cover a service that won't stay up, a GPU node that won't start, a memory conflict, and restoring a backup.
