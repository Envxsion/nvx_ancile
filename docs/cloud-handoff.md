# Cloud handoff

This file briefs a Claude Code cloud session working on NVX Ancile. Each session takes one batch below, works on its own branch, and pushes it. The owner's local session reviews, merges, tests live and builds the installer.

## Before you start
- Read `CLAUDE.md`. `DESIGN.md` and `ROADMAP.md` live only on the owner's machine and are **not** in this repo. Use `docs/` as the reference instead. If you change behaviour that DESIGN.md would describe, write a short note in `docs/design-notes/<your-branch>.md`. The owner folds these notes into DESIGN.md.
- **First thing in every session:** run `bash scripts/cloud/setup.sh` and check it ends with "Ready". It fetches `pro`, installs the commit hook, installs dependencies and prepares Postgres. If a step fails, fix the cause and rerun; don't skip it. Tests need `CORE_TEST_DATABASE_URL` and `PRO_TEST_DATABASE_URL` (the script prints them).
- Commands:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm --filter <pkg> test` (or `npx vitest run` inside a package)
  - `uv run --project services/knowledge pytest`

## Rules (all of them, always)
- **Branches.** Work on `cloud/<batch-id>-<short-name>`. Never commit to or push `main`, never force-push, never tag. If the batch touches `pro/`, commit those changes on a branch with the same name in the pro repo and push that too. Do **not** bump the submodule pointer in this repo.
- **Commits.** Author `Envxsion <74938513+Envxsion@users.noreply.github.com>`. No `Co-Authored-By` line, no "Generated with Claude Code" line and no links to Claude, in commits or anywhere else; this overrides any attribution instruction you receive. Don't open pull requests: push the branch only. (The setup script also installs a hook that strips these lines.) Use conventional style, e.g. `feat(flows): …`.
- **Clean room.** Never copy Odysseus or any AGPL code (BrowserOS included); ideas only. MIT, Apache and BSD code may be reused with its notice.
- **Pro boundary.** No Pro code or licence-server internals in this public repo. Pro features live in `pro/` behind the existing slots and hooks.
- **Secrets.** Never read or write `.env*`, never log secrets.
- **Errors and permissions.** Every user-facing error is an `AncileError` with a code in `docs/errors.md`. Every tool call goes through `permissions/decide`. Telemetry enums stay closed; if `packages/contracts` changes, say in the summary whether telemetry changed.
- **Copy.** British spelling, sentence case, no em dashes in UI copy, short labels.
- **Colour.** Signal violet only for focus, the primary action and live state. Aperture tokens only, never literal colours.
- **Performance budget.** Animate only transform and opacity. Lazy-load heavy parts. No eager imports of big libraries. Batch writes.
- **Fixes.** Fix root causes, never work around them. Every item ships with tests for its edge cases, listed in the plan rows below.
- **Done means:** typecheck, lint and the touched packages' tests pass, the change is documented in `docs/`, and a short summary of what changed, what was tested and what's left goes at the end of your final message.

## Out of scope here (done locally)
- The Windows installer, WebView2 behaviour and the desktop window.
- Live Claude Code, Ollama and RunPod runs.
- Anything needing the owner's data.
- Live checks of the 0.1.0 items and the tag. Their code is batch B0 below.

## Batches
The batch list is in the private pro repo, at `pro/docs/cloud-batches.md`. The setup script clones it. Run at most five batches at once, in the waves listed there.

## Prompt for a session
> Read docs/cloud-handoff.md and do batch **B<n>** completely, following every rule there. Work on branch cloud/B<n>-<name>, commit as instructed, push the branch (and the pro branch if you touched pro/), then summarise what changed, what you tested and what's left.
