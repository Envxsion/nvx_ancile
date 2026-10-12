# Activity: what is running

One place to see what is going on, read-only. Open it from the status bar (the count shows only while something runs, "2 running"), from the palette (**Show activity**), or with `g r`. Open a row to go to its thread, at its message when NVX Ancile knows which one.

Nothing in the panel starts, stops or signals anything. It never lists the computer's processes: every row is either work NVX Ancile started, or something read from a Claude Code session's own transcript.

## What it lists

| Group | Rows | Where it comes from |
|---|---|---|
| In NVX Ancile | Every durable run not finished yet: answers, agent turns, research, fact-checks, flows in the lab, automations, diagnostics and Claude Code turns sent from NVX Ancile. Each shows the step it is on ("Searching sources", "Checking claims 3/7"), "Waiting for your decision", "Waiting for a GPU node" or "Queued" | The run store, and each run's latest step, fact-check or flow event |
| Claude Code elsewhere | Sessions open in a terminal or an IDE right now, and sessions another program wrote in the last minute, with the folder and the thread each is in | The read-only look at Claude Code processes (docs/claude-code.md, One session, one place) and the session list. A session NVX Ancile itself is writing shows as its run instead |
| Subagents | Task or Agent calls with no result yet (a background agent: until its notification) | The session's transcript |
| Background shells | Commands Claude Code started with `run_in_background`, and whether the transcript says they finished, failed or were stopped. Finished ones stay for ten minutes | The session's transcript: the call, its result (the shell's id), task notifications, BashOutput or TaskOutput results and KillShell or TaskStop calls |

Transcripts are read for sessions a terminal holds, sessions written in the last fifteen minutes, and sessions a turn from NVX Ancile is writing (the newest 24). Each is read from where the last read stopped, so a long session costs only its new lines; a file larger than 16 MB is read from its last 16 MB the first time.

"As far as the transcript says" is all a shell's state is: a shell whose terminal closed without a notification still reads "Running" until its session goes quiet for fifteen minutes.

## Shell commands

A command shows as its first line, cut to 80 characters, with anything shaped like a secret replaced by "…": the key shapes the log redactor knows (`sk-…`, `ghp_…`, `Bearer …`, passwords in URLs), assignments such as `API_KEY=…` or `DB_PASSWORD=…`, flags such as `--token …` or `--api-key=…`, authorisation headers, and any long opaque run of characters. The rest of the command, and everything it printed, stays in the transcript.

## The count and live progress

Core publishes `activity.changed` with the number of rows running or waiting whenever it moves: after run and Claude Code events, and on a slow tick (every 30 s). While the panel is open and something runs it asks again every three seconds. Finished shells do not count.

## The background import

While Claude Code sessions are being brought in (docs/claude-code.md), the panel shows "Bringing in 120 of 2,400 sessions (nvx_ancile)". The Cockpit tells Core when you type (`POST /activity/typing`, only while an import runs, never what you typed), and the import waits until you stop; the line then reads "Paused while you type".

## API

`GET /api/v1/activity` and `POST /api/v1/activity/typing` (docs/api.md, Activity). Shapes: `packages/contracts/src/activity.ts`.

## Limits in this release

- On Windows a terminal started without a session id (`claude -c`, then `/resume`) shows only while it writes (the one-minute rule); see docs/claude-code.md, Limits.
- Subagents and shells come from transcripts, so one started in a session NVX Ancile cannot find the file of (an unusual projects folder) is not listed.
