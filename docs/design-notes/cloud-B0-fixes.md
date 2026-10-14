# Design notes: cloud/B0-fixes

Behaviour from batch B0 (fixes before 0.1.0) that DESIGN.md would describe, for the owner to fold in. Each line says what is true now; the docs named carry the detail.

## Settings and the look

- **Device-only settings.** Zoom, rail and drawer widths, browser-safe keys, custom CSS and performance never leave the browser: the prefs PUT strips them, export and import skip them, and Pro sync never carries them (`DEVICE_PREFS` in contracts prefs.ts; docs/configuration.md).
- **Custom CSS.** Stays on this device, asks before it is first applied, and shows a "Custom CSS on" chip in the status bar. It is suspended while anything in the protected layer is open.
- **Protected layer.** Approval and permission UI renders in its own top layer (`#ancile-protected`), above anything custom CSS or a page can draw. A visibility check pauses its answers while something covers it, and says so.
- **Materials.** Grain, glass and gilt are visible at their intended strength; a settings row says when Transparency or Effects overrides them.
- **Reduced motion.** The in-app setting drives Motion too, keeping short fades and dropping movement; scrolling follows it.
- **Contrast.** Every text token meets 4.5:1 on its surfaces, checked by a test.
- **Load and failure states.** Every panel shows a labelled skeleton while it loads, and a failure in its own words with Try again when a read fails, never an empty state or a create action in place of data that did not load (`LoadFailed`, `StaleNotice`; `cockpit.offline`, `cockpit.load_failed`).
- **Version.** Every part reads its version from its build, and a test keeps the declared versions in step (docs/desktop.md, The version).

## Rail, composer and messages

- **Rail.** Flows and Automations are places in the rail (`g w`, `g u`).
- **Composer.** With Slash and @ menus off, typing `/` or `@` says why nothing opens, with Turn menus on. Compare models (Beam) sits beside the attachments in every thread, Claude Code threads included; the draft is the question and leaves once the beam starts.
- **Messages.** Beam this question (Shift B) asks several models the question already asked, so their answers become its versions; on an answer, it beams that answer's question.
- **Tool steps.** Tool, MCP and command steps are distinct live cards (kind, icon, ticking timer, done or failed with duration, one-line result) under a "Working now" strip.
- **Claude Code results.** A tool result always joins the answer that made its call, whatever came between (mapper version 4, repaired in place for older imports).

## Models and cost

- **Pickers list only models that can answer now.** Needs a key, switched off or not pulled: never offered. Admin → Models lists every model with what it needs. When Claude Code cannot answer, a separate "Set up Claude Code" row says why. Pulled Ollama chat models are listed by themselves; OpenRouter models are added one by one.
- **Test models.** A model that does not use AI is a "Test model" ("Test model · no AI" in the palette); the setting is "Keep test models (no AI) in pickers".
- **Claude Code cost.** Wherever a Claude Code cost shows it reads "Included in your Claude plan" (or names where an API sign-in bills it); its estimate at list prices is never added to a total or a flow's `month_spend_usd`.
- **Fact-check judges.** At most one Claude Code judge call at a time by default (Settings → Claude Code, 1 to 4), since each is a session on the plan.
- **Source levels.** "Full" is now Passages: a question gets the passages that match it best, never the whole source.

## Usage

- **Settings → Usage** opens with Context now (the last open thread's context, where the status bar's meter leads), says why every empty block is empty, and counts Claude Code sessions brought in from the terminal. A Claude Code answer counts once, where it lives now.

## Automations and memory

- **Every built-in automation reads its switch and options**, with real option forms (choices, numbers, switches with hints). Built-ins that did not exist (tldr, model suggestions, model stats rollup) are gone from the list. Memory capture is linked to the memory mode.
- **Memory backup** stays off until a remote is set, with remote setup and Test push in its dialog; git never prompts for credentials.

## Permissions

- **One name: Permissions** (no "grants" in the UI). Expired permissions carry an Expired badge and a filter (All, Active, Expired), and say when the rest end.

## Compute

- **One key screen.** A RunPod key saved anywhere goes to Settings → API keys and connects the Controller; Core sends it again whenever the Controller comes back without it.

## Pro (pro/docs has the detail)

- **Sync** skips anything whose scope keeps data on the machine and removes copies synced before; device-only settings stay out. New computers join by approval from one that already syncs, or a pairing code, comparing a code shown on both (the relay change is written up in pro/docs/sync-withdraw-approve.md).
- **Team**: change passphrase (ends other sessions), a public address for invite links, an invite code field, resend and withdraw, an admin reset link and a recovery code.
- **Seats**: a Pro check per member, so a free member never gets Pro features; licence actions are for admins (the `member_seats` claim the licence server must add is in pro/docs/license-server-brief.md).
- **Flow lab**: an empty tab is one centred message.
