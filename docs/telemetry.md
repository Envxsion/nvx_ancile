# Usage statistics

NVX Ancile can send anonymous usage statistics so it can keep getting better. It is **off until you say yes**, it never sends what you wrote, and turning it off erases everything it kept.

## Turning it on or off

- The first time you finish setup, and on Home until you answer, NVX Ancile asks once: **Share anonymous usage stats?** Choose **Share stats** or **No thanks**.
- Change your mind at any time in **Settings → Privacy**. The same page shows **What is shared**: the exact batch that would be sent next, and today's counts so far.
- The desktop app and official releases send to `https://ancile.nvx.sh/api/telemetry`, and only after you say yes. Running from source, there is no address unless you set `NVX_TELEMETRY_URL`, so nothing is ever sent, whatever you choose.

Turning it off deletes the install id, everything waiting to be sent and every counter. Only the date NVX Ancile was first started is kept, and it is never sent.

## What is sent

Counts and timings, always in ranges, never exact:

- **Your setup:** the operating system and processor type, memory and core count in ranges, the browser and its major version, the primary language (`en`, never `en-AU`), the whole-hour time zone offset, light or dark theme, whether the window is phone-sized, and whether you use the desktop app or a browser.
- **What is in your workspace:** how many notebooks, threads, sources (by kind: file, link, pasted text), memory files, flows, GPU nodes, MCP servers and automations, all in ranges; how many ready models you have by where they come from (Anthropic, OpenAI, Google, OpenRouter, your own server, a GPU node, Ollama); your permission preset and memory mode; the edition (free or Pro).
- **How often things get used:** a count per day of each feature (branching, fact-checking, flows, the palette and so on), and whether you reached it by a shortcut or a click; the first time you use each feature; the first-run steps you reached.
- **How well it works:** time to the first word of an answer, time to a full answer, retrieval, flows and start-up, as the day's median and 95th percentile ranges; how many answers fell back to another model, failed or were stopped.
- **What went wrong:** the error codes from [errors](errors.md) that came up that day (for example `flow.model_unready`), and for a crash only where it happened and the kind of error (`TypeError`), never its message.
- **Flow shapes:** when you publish or turn on a flow, how many nodes it has, how deep it goes, which kinds of node it uses and how many connections narrow what they pass on. Never its name, its prompts or its models.

## What is never sent

Anything you wrote or were answered, file names or contents, notebook, thread, flow or model names, links or domains, prompts, memory, error messages or stack traces, exact counts or times, your licence key or licence id, your email or account, your IP address (the server keeps only a keyed hash of its first part, for rate limits), a named time zone, the full browser identity, or anything that could identify your computer.

The install id is a random number made when you say yes. It is not linked to your licence: the only licence-related value sent is the edition.

## How it is sent

- To that address over HTTPS, at most once an hour, in batches of up to 50 entries and under 8 KB.
- Each batch carries a small proof of work (`x-nvx-stamp`), so no secret has to ship in the app.
- A batch that fails is tried once more, then dropped. Nothing waits for it, and a failure never affects the app.
- The server refuses any entry that is not on the list in `packages/contracts/src/telemetry.ts`, which is the whole of what can be sent.
- Statistics are kept for 12 months.

## For developers

The contract is `packages/contracts/src/telemetry.ts` (events, every allowed key, every bucket). Core collects in `services/core/src/telemetry/` from the API and the run event log; the Cockpit adds shortcut-or-click counts and browser details (`apps/cockpit/src/lib/telemetry.ts`). Nothing is recorded until consent, and every envelope is checked against the contract before it is queued.
