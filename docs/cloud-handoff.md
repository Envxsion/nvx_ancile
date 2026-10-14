# Cloud handoff

This file briefs a Claude Code cloud session working on NVX Ancile. Each session takes one batch below, works on its own branch, and pushes it. The owner's local session reviews, merges, tests live and builds the installer.

## Before you start
- Read `CLAUDE.md`. `DESIGN.md` and `ROADMAP.md` live only on the owner's machine and are **not** in this repo. Use `docs/` as the reference instead. If you change behaviour that DESIGN.md would describe, write a short note in `docs/design-notes/<your-branch>.md`. The owner folds these notes into DESIGN.md.
- Setup: `bash scripts/cloud/setup.sh`. Tests need `CORE_TEST_DATABASE_URL` and `PRO_TEST_DATABASE_URL` (the script prints them).
- Commands:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm --filter <pkg> test` (or `npx vitest run` inside a package)
  - `uv run --project services/knowledge pytest`

## Rules (all of them, always)
- **Branches.** Work on `cloud/<batch-id>-<short-name>`. Never commit to or push `main`, never force-push, never tag. If the batch touches `pro/`, commit those changes on a branch with the same name in the pro repo and push that too. Do **not** bump the submodule pointer in this repo.
- **Commits.** Author `Envxsion <74938513+Envxsion@users.noreply.github.com>`. No `Co-Authored-By` line and no links to Claude in messages. Use conventional style, e.g. `feat(flows): …`.
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
- The 0.1.0 items. They are done locally before the tag.

## Batches
Run at most four at once. Waves avoid clashes in shared Cockpit files.

**Wave 1**
- **B1 Speed and feel.**
  - P1: split the app, so Settings, Admin, Setup and Notebook load on demand, with vendor chunks and a CI budget of under 900 KB for the entry chunk.
  - P2: streaming must not re-render the composer or the list.
  - P3: memo rows and unmount far-off ones.
  - P4: graph layout in a web worker.
  - P5: route loaders that prefetch data.
  - P7: rail virtualisation.
  - TC1: a "new text below" pill.
  - TC2: one press-feedback token.
  - D6: codemod literal font sizes, radii and colours to tokens, plus a stylelint rule.
  - D9: popover focus management, aria-busy while streaming, labels on lazy rows.
- **B2 Flows.**
  - FW1: tests for every node kind; `retrieve` errors instead of returning ''; one shared template list for server and Cockpit.
  - FW2: a setup chip on nodes missing a key, a RunPod connection or an MCP sign-in, with a "Set up" action.
  - FW3: new nodes: http request, webhook in, code (sandbox Python), JSON extract with a schema, classifier, for-each, memory write, image, Claude Code task, wait, variables, translate, redact PII, cost guard, notify. New tools: web fetch and search, git, read-only SQL, notebook and memory search. All of them go through the gate and have cost estimates.
  - FW4: about 30 templates by use case, each with a preview and a test-model sample run.
- **B3 MCP.**
  - MC1: "Use in Ancile" for Claude Code's servers. Read the config, move env and header values into the secret store, resolve `${VAR}`. Skip claude.ai and plugin servers, with a reason.
  - MC2: an "Add server" catalogue with presets (Filesystem, Postgres, Playwright, Slack, Notion, Linear, Sentry, Supabase, Vercel and more), a connection test, and the SSE transport.
- **B4 Sources, memory, evidence.**
  - S1: native `list_sources`, `search` and `read_source` tools.
  - S2: "always include" whole sources within a budget.
  - S3: re-search from the tool loop.
  - S5: edit text and note sources as new versions.
  - S6: tags, author, date and language in the UI.
  - M1: change the scope when approving.
  - M2: a "remember" / "never" detector.
  - M3: show why something was learned.
  - M4: project-findings, model-quirk and repeated-habit detectors.
  - M5: thread and task scopes, plus a scope sanity check.
  - M6: inline entry edit and move.
  - M7: embedding neighbours, idle-batched capture, cache breakpoints.
  - EV1: stream claims and verdicts live.
  - EV2: a "Searched N sources" step.

**Wave 2**
- **B5 Automations, grants, review.**
  - A1: wire every built-in's switch and options. Do this one first if 0.1.0 hasn't landed it; check git log.
  - A3: event triggers, webhook, append-note and export actions, and a test run.
  - A4: a "describe it" box that produces a draft of the existing automation spec, validated with Zod and shown as a form. No generated code.
  - G2: create grants up front (deny too), edit action and effect, scope target links, search, bulk revoke, history.
  - R1: reviewer choice, order and enable; add-only user rules; per-preset thresholds; the active chain shown in Admin.
- **B6 Chat feedback and look.**
  - CH4: a run timeline in the drawer and an end-of-turn summary.
  - D10: a copy pass to cut filler, plus a "Pro details" setting.
  - D11: the motion system (springs, shared-element moves, a glow edge while AI works, number tickers), compositor-only with a frame-drop fallback.
  - D12: a light theme with its own art direction, plus the Graphite, Midnight, Paper, Aurora and High contrast themes and a token-only theme editor.
  - D13: grow the icon set, with animated variants.
- **B9 Coding lab.**
  - LB1: a doom-loop guard.
  - LB2: AGENTS.md and CLAUDE.md loading, and `/init`.
  - LB3: a formatter setting.
  - LB4: Plan and Build modes.
  - LB5: redo and revert across turns.
  - LB6: `@file`, a gated `!cmd`, and command files.
  - LB7: LSP diagnostics.
  - Ideas from OpenCode, which is vendored under MIT in `vendor/opencode`.
- **B10 Pro (pro repo branch plus slots here).**
  - PR2: permanent gilt trim with a Pro styling setting.
  - PR3: share flows, Beam sets, packs and test sets with a team or synced devices.
  - B2: Beam results inline in the thread.
  - CP1: an attach picker in thread and notebook headers, and a pack made from a thread.
  - FL1: learned-router and shadow chips.
  - Y4: choose per kind and per notebook what syncs; sources, memory and automations as encrypted blobs. Coordinate the relay API through a note; the relay is the owner's other repo.
  - Y5: full history on first sync.

**Wave 3** (touches everything, so last)
- **B7 Settings and guide.**
  - ST1: merge Settings into Look, Reading & writing, Keyboard, Notifications, Accessibility, Models & keys, Usage & costs, Privacy & sync and Advanced, with redirects. Admin becomes System, Permissions, Compute and Extend.
  - ST2: an Essentials or Everything mode.
  - C2: Compute and GPU fleet in one screen.
  - H1 to H6: visual articles; tour engine v2 (predicate waits, branching, resume, rich cards, Do it for me); a tour for every feature and settings group, with a CI check; sandbox mode on the offline test model; jargon cards.
- **B8 Workspace.**
  - WS1: docking and snapping panels with saved layouts.
  - WS2: a terminal (xterm.js plus a Rust PTY via portable-pty) that opens in the notebook's project folder; agent commands appear in a read-only tab.
  - WS3: one project folder per notebook, used everywhere.
  - W1: a new window per thread, and state in the URL.
  - W2: tags and bookmarks.
  - W3: a prompt library and personas.
  - W4: a hardware fit check.
  - TC3: drag threads into notebooks, with Undo.
  - TC4: bulk actions.
  - The Rust side must `cargo check` on Linux: install the Tauri Linux dependencies in the session if needed.

## Prompt for a session
> Read docs/cloud-handoff.md and do batch **B<n>** completely, following every rule there. Work on branch cloud/B<n>-<name>, commit as instructed, push the branch (and the pro branch if you touched pro/), then summarise what changed, what you tested and what's left.
