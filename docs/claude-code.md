# Works with Claude Code

NVX Ancile works with the Claude Code you already use. Your Claude Code sessions, from every project on this computer, appear in NVX Ancile as threads, in a notebook named after each project's folder, and they stay in step as you keep working in the terminal.

NVX Ancile uses your own installed Claude Code, unchanged. It never modifies it, never reads its sign-in files, and never sees your Claude password or tokens.

## What it does

- **Finds Claude Code.** Settings → Claude Code shows whether it is installed, its version, and whether it is signed in (the sign-in method and plan only).
- **Installs it if you want.** With **Install automatically** on (the default), or when you press **Install**, NVX Ancile runs Anthropic's official installer (`claude.ai/install`). It installs into your home folder and needs no admin rights.
- **Checks the install is Anthropic's.** NVX Ancile compares the Claude Code program with the checksum in Anthropic's release list for that version, and on Windows and macOS checks it is signed by Anthropic. An install that fails the check shows "This Claude Code install could not be verified", and NVX Ancile will not run sessions through it.
- **Brings your sessions in.** With **Import automatically** on (the default), every session comes in by itself, a little after NVX Ancile starts and whenever Claude Code writes to a session. You can also pick sessions in the list and press **Bring in**.
- **Keeps them in step.** Keep working in the terminal: new messages are added to the thread. A session open in a terminal right now is read only, never written to.
- **Carries them on.** Type in a Claude Code thread and your own Claude Code answers, in the session's own folder, streaming into the thread like any answer (see Live sessions).
- **Keeps everything.** Every message of a session comes in: what came before each compaction, and every path a rewind left behind as a branch.

## Sign in

Signing in is Claude Code's own: press **Sign in** and Claude Code opens its sign-in in your browser, exactly as `claude auth login` does in a terminal. NVX Ancile only asks Claude Code afterwards whether it is signed in. If the window cannot open from NVX Ancile (for example on a Linux machine without a desktop), run `claude auth login` in a terminal.

You do not need to be signed in to see and bring in sessions: they are already on your computer. **Sign out** runs `claude auth logout`, and only when you press it.

Claude Code's usage counts against whichever account Claude Code is signed into (your Claude plan, or API billing), exactly as in the terminal. Settings → Usage shows your plan's limits as Claude Code's own `/usage` does (see Usage), and token counts from your sessions; a cost, where Claude Code reports one, is its estimate at API list prices, never your bill.

## Names and notebooks

- A thread is named after the session: the name you gave it in Claude Code (`/rename`), else its summary, else its first prompt. Rename the session in Claude Code and the thread follows, unless you renamed the thread in NVX Ancile, which then wins.
- Sessions from one folder go into one notebook named after that folder, such as `cyberfolio` or `nvx_ancile`. A notebook you already have with exactly that name is used, unless it already belongs to another folder. Two folders with the same name are told apart by their parent folder: `nvx_ancile (Desktop)`.
- Each thread remembers the folder its session runs in, exactly as Claude Code recorded it, so it can carry on in that folder later.
- A notebook made for a folder gets its own colour: the first of azure, coral, jade, amber, cyan and magenta that no other notebook (not archived) uses. When all six are taken it gets the least used one, and the same folder always gets the same one. Folder notebooks made before colours get theirs on the next import pass. A notebook you already had, or chose, keeps its colour.

## Excluded folders

Some sessions are not yours: the claude-mem plugin, for example, runs automated "observer" sessions in `~/.claude-mem`. Sessions from an excluded folder (or any folder inside it) are never listed, never brought in automatically, and bringing one in by hand says "Sessions from that folder are not brought in".

- Settings → Claude Code → **Excluded folders** lists them (`exclude_folders`). `~` means your home folder. On Windows, case and slash direction do not matter. `~/.claude-mem` is excluded by default.
- **Don't bring in this folder** on a session adds its folder to the list.
- What already came in from an excluded folder is put away when NVX Ancile starts and whenever the list changes: a thread whose messages all came from Claude Code is archived (never deleted) and no longer synced. A thread you wrote in from NVX Ancile is left exactly as it is. A notebook NVX Ancile made for that folder is archived too once it has no threads left that are not archived.

## How sessions look in a thread

- Your prompt is your message. Everything Claude Code did in answer (its thinking, each tool call with its result, and its reply) is one answer, so tool calls sit next to their results.
- The answer reads like an editor's timeline. Each tool step is one line saying what it did and to what, and opens onto the detail:
  - **Read** shows the file with line numbers; **Edit** and **Write** show a diff; **Bash** (and PowerShell) a terminal block with the command and what it printed; **Grep** and **Glob** a list of matches; **WebFetch** and **WebSearch** their links; **TodoWrite** a checklist.
  - A subagent (the Task or Agent tool) is folded under the call that started it; open it to read its conversation. An MCP tool (`mcp__server__tool`) shows its server, tool and arguments.
  - More than four steps in a row fold into "Worked through N steps" (while it runs, "Working through N steps").
  - Thinking is folded to one line until you open it.
- Long messages start folded at about twelve lines; long pastes too.
- A Claude Code thread shows no NVX Ancile context estimate: the context is Claude Code's, and its own count (with where it compacts) shows in the same meter once its session is open (`GET /claude-code/threads/:id/live`).
- What Claude Code itself wrote on your side of the conversation is not shown as if you typed it:
  - **Commands you ran** (`/model opus`, or `!git status` in shell mode) are a chip showing the command, with what it printed folded under it (colour codes removed).
  - **Notifications** are slim rows, not your words: a background task that finished or failed (with its result), a message from another Claude Code session ("Message from nvx_folio"), and an agent's report.
  - **Interruptions** ("[Request interrupted by user]") read "Stopped by you".
  - Claude Code's notes to the model (`<system-reminder>`) and its caveat before local commands are left out.
- Where Claude Code compacted the conversation, a divider reads "Conversation compacted here", with "What came before" (Claude Code's summary) folded under it. Everything before the compaction is in the thread above the divider.
- Very large tool results are shortened, with a note saying how much was left out. Images up to 512 KB come in; larger ones are noted.
- If you rewound a session in Claude Code (Esc Esc) and went another way, the thread has a branch there, and the newest path is the one shown. Every path comes in, including ones rewound before NVX Ancile ever saw the session.
- A prompt you typed while Claude Code was still working comes in as your message, where Claude Code took it in.

### For developers: what the Cockpit receives

Every message from Claude Code has `provenance.claude_code = { session_id, uuid, uuids, kind?, command?, notification?, last_api_id?, subagent? }`. Prompts and answers have no `kind`. The others:

| `kind` | role | parts | extra fields |
|---|---|---|---|
| `command` | user | one text part, `/name args` (or `! command`) | `command: { name, args, output }`; `output` is the printed stdout then stderr, ANSI codes removed, or `null` |
| `notification` | system | one text part: the body as markdown, tags removed (may be empty) | `notification: { source: 'task' \| 'session' \| 'agent' \| 'system', title, from?, status? }` |
| `compact_boundary` | system | one empty text part | none; the divider |
| `compact_summary` | system | one text part: Claude Code's summary | none; it hangs off the divider |
| `interrupted` | system | one text part, "Stopped by you" | none |

Titles are "Background task finished: <summary>" (or "failed", "stopped"), "Message from <session>", "Report from an agent" (with `from` naming it) and "Note from Claude Code" for a wrapper NVX Ancile does not know yet. Tool results stay strings, line-number gutters included.

When the mapping changes, `MAPPER_VERSION` (services/core/src/claudecode/map.ts) goes up. The next import pass rebuilds every thread made by an older version, keeping the thread, its title, notebook and place in the list, as long as the thread holds only messages from Claude Code (turns sent from NVX Ancile count: they are Claude Code's too). A thread with anything else written in NVX Ancile is kept as it is; only new messages use the new mapping. Version 3 brought full history: threads imported before it are rebuilt with every branch and everything before each compaction.

A live answer also has, when Claude Code reports it, `provenance.claude_code.cost_estimate = { usd, note }`: Claude Code's own estimate at API list prices, the same number goes in the message's `usage.cost_usd`. It is not what your account is billed (a Claude plan is not billed per token at all).

## Live sessions

Type in a Claude Code thread and it carries the session on, in your own installed Claude Code, unchanged, signed in as it is in your terminal.

- **Where it runs.** In the session's own folder, exactly as Claude Code recorded it (the `nvx_folio` session runs in its `cyberfolio` folder), with your own CLAUDE.md files, settings, skills, plugins, hooks and MCP servers, as in the terminal (Claude Code's user, project and local settings).
- **How it runs.** Through Anthropic's Agent SDK, in the Claude bridge: the same way any program built on the SDK drives Claude Code. Never `claude -p`, never a terminal emulator, never by intercepting its network traffic, and never by reading its sign-in files. The program run is the one NVX Ancile found and verified (Settings → Claude Code); an install that fails the check runs nothing.
- **A turn is a run.** Each message you send is a run in Admin → Runs, with a trace, a status and Stop, and its answer streams into the thread like any other: thinking, text, and each tool step as it happens. Stop (or cancelling the run) is Claude Code's own interrupt; what streamed is kept, marked stopped.
- **One session, one place.** NVX Ancile never opens a session twice, and never writes to one that Claude Code is using somewhere else: if the session's file was written by another process in the last minute, sending says "This session is open in Claude Code somewhere else". Close it there, or press **Continue as a branch**: that forks the session (`as_branch`), so both carry on separately.
- **Branches are forks.** Send from an earlier message (edit, regenerate, or reply to an older answer) and Claude Code forks the session at that message's entry; the fork is a new Claude Code session, bound to the same thread, and its messages hang off that message as a branch. One thread can hold several sessions, one per branch. Sending from the latest message of a branch carries on the session that branch belongs to.
- **Nothing twice.** Each message a turn writes carries the ids Claude Code gives the same entries in its own file, using the same mapping an import uses, so the import watcher adds nothing twice; it leaves a session alone while a turn is writing it, and the turn brings in anything else Claude Code wrote (a compaction, say) when it ends.
- **Model and effort.** A send may choose the model and effort; they apply to the session from then on.
- **Telemetry.** With Claude Code usage reporting off, sessions run with `DISABLE_TELEMETRY` too.

### Approvals

Every tool call Claude Code makes is asked about before it runs, on its real arguments, and NVX Ancile's permission engine decides, as the principal `agent:claude-code`. The same grants, policies and presets apply as for the assistant and the lab. NVX Ancile never answers with Claude Code's own "always allow" choices: what you remember lives in NVX Ancile's grants (Admin → Grants), so Claude Code asks again next time and the grant answers.

| Claude Code tool | Checked as | Resource | Tier |
|---|---|---|---|
| Read, Glob, Grep, LS | `fs.read` | `fs:<path>` | runs inside the session's folder; asks outside it |
| Edit, Write, MultiEdit, NotebookEdit | `fs.write` | `fs:<path>` | asks; critical outside the session's folder |
| Bash, PowerShell | `shell.exec` | `shell:<command>` | asks; critical for dangerous commands (`sudo`, `rm`, `curl … \| sh`, per the preset) |
| WebFetch | `web.fetch` | `http:<url>` | asks |
| WebSearch | `web.search` | `web:<query>` | asks |
| `mcp__ancile__search`, `read_source` | `knowledge.search` | `notebook:<id>` | runs |
| `mcp__ancile__memory_search` | `memory.read` | `memory:all` | runs |
| `mcp__ancile__<hosted tool>` | the hosted tool's own action | its own resource | its own tier |
| any other `mcp__<server>__<tool>` | `mcp.<server>.<tool>` | `mcp:<server>/<tool>` | asks |
| Agent, Task, TodoWrite, Skill, ToolSearch, plan mode, background task tools | `claude_code.<tool>` | `claude_code:<tool>` | runs |
| anything else | `claude_code.<tool>` | `claude_code:<tool>` | asks |

Paths are checked as written by Claude Code, in posix form (`C:\code\app\a.ts` is `fs:/C:/code/app/a.ts`), with links resolved. NVX Ancile's protected paths (`.git`, `.env*`, keys) are refused as everywhere else.

A call that asks shows in the normal approval dialog with its full arguments, and you may change them before approving it once (for example, narrow a shell command): the permission is decided again on your changed arguments, and Claude Code runs the changed call. A denial goes back to Claude Code with your reason. A question nobody answers expires like any other (24 hours by default), which Claude Code hears as a denial.

### Sources and citations

The notebook's notes and sources are the session's primary sources. Each live session gets NVX Ancile's MCP server, `ancile`, with `search` (the notebook's sources, numbered passages with their source and chunk ids), `read_source` and `memory_search`, plus the tools of every MCP server NVX Ancile hosts, so Claude Code never holds their secrets. A short, unchanging note in Claude Code's system prompt names the notebook and asks it to cite passages by their `[n]` markers as returned.

Passages are numbered across a turn, so the markers in an answer are unique. When the answer is written, every marker it used becomes a citation (the evidence panel opens the exact passage), a marker that names no passage is removed, and the answer's retrieval trace is kept. In a grounded notebook the answer is fact-checked like any other.

### Commands

Typing `/` in a Claude Code thread lists Claude Code's own commands for that folder (its built-ins, your skills, plugins, MCP prompts and custom commands), read from a session that sends nothing and writes no transcript, so it costs nothing; new commands appear without an NVX Ancile update. The built-ins NVX Ancile does better itself point at its own screens, so nothing clashes:

| Command | In NVX Ancile |
|---|---|
| `/mcp` | Opens MCP servers (with `reconnect`, `enable`, `disable` and the session's servers to complete) |
| `/permissions` | Opens Admin → Permissions |
| `/usage`, `/cost`, `/context`, `/stats` | Opens usage: Claude Code's own context count and where it compacts, the last turn's tokens and estimate, the plan limits, and a link to Settings → Usage |
| `/branch`, `/fork` | Branches the thread here (a fork in Claude Code) |
| `/rewind`, `/checkpoint` | Go back to an earlier message and branch from it |
| `/clear`, `/new`, `/reset` | A new thread in this folder |
| `/resume`, `/continue` | Another of this folder's sessions |
| `/login` | Claude Code's own sign-in |
| `/memory` | NVX Ancile's memory (Claude Code's CLAUDE.md files still apply) |
| `/config`, `/settings` | Settings → Claude Code |
| `/model` | Changes the session's model (Claude Code's models to complete) |
| `/effort` | low, medium, high, xhigh, max or auto |
| `/compact [instructions]`, `/init`, `/review`, `/security-review`, skills and the rest | Sent to Claude Code as typed |
| `/theme`, `/vim`, `/terminal-setup`, `/doctor`, `/ide`, `/statusline`, `/keybindings`, `/hooks`, `/upgrade`, … | Work in a terminal only; the list says where to do them instead |

A command you or a plugin made that shares a built-in's name is yours, and goes to Claude Code.

### Usage

Settings → Usage (also the status bar's usage segment, and **All usage** in a Claude Code thread's usage popover) shows:

- **Plan limits**, as Claude Code's own `/usage` shows them: "Current session (5 hours): 42% used, resets at 3:40 pm", "This week: 18% used, resets Mon 9:00 am", and a weekly row per model when your plan has one, each a meter that turns amber from 70% and red from 90%. "Updated 2 min ago" says how fresh they are; **Refresh** asks Claude Code now. With an API key (or a cloud provider) it says "Plan limits apply to Claude subscription sign-ins only."
- **NVX Ancile usage**: tokens and recorded cost today, or over the last 7 or 30 days, with a bar per hour or day and a split by engine (chat and flows, Claude Code, the lab) and by model. Claude Code's part of the cost is its estimate at API list prices, and says so. GPU compute shows the Controller's month when a node is set up. Pro's Insights goes deeper.

Where the plan figures come from:

- Every `rate_limit_event` a live session reports (the Agent SDK's message for plan sign-ins) updates its window as it happens.
- The Agent SDK's usage report (the data behind `/usage`), which the SDK marks experimental: NVX Ancile asks for it at most every 3 minutes, after a turn on the open session, or when you press Refresh (at most every 20 seconds; with no session open it asks from a session that sends nothing and writes no transcript). It asks without the scan of your local transcripts. If this Claude Code does not offer it, or answers in a shape NVX Ancile does not know, the figures from `rate_limit_event` stand.
- The latest figures are kept in NVX Ancile's settings, so they are there after a restart. Only the plan's kind and the windows are kept, never your account, email or organisation.

The context meter (the status bar, and the line above a Claude Code thread's composer) is one meter for every thread: "62% of context: compacts at 95%", with a tick at the line. In a normal thread it is NVX Ancile's estimate for the model that would answer, which compacts the older messages by itself at 95% (and offers **Compact now** from 80%). In a Claude Code thread it is Claude Code's own count and Claude Code's own auto-compact line, once its session is open.

### Traces

Every turn is a run with a trace (Admin → Traces): a span per model call (with its tokens), a span per tool call (with the permission decision, how long an approval waited, and whether you changed the arguments), and a span per call to NVX Ancile's MCP server. Tokens come from Claude Code's own usage. The cost is shown only when Claude Code reports its estimate, and is labelled an estimate at API list prices, never a bill.

## How NVX Ancile reads sessions

Claude Code keeps sessions in its own files, in a format that is its own. NVX Ancile lists sessions and reads subagents through Anthropic's Claude Agent SDK, the supported way.

### Nothing lost: full history

The SDK gives a session's current conversation only, from its last compaction on: what came before, and paths left by a rewind, are not in it. So NVX Ancile also reads the session's own file, read-only, the way you could open it in an editor (services/core/src/claudecode/transcript.ts, `TRANSCRIPT_READER_VERSION`):

- The file is found by the session's id among Claude Code's project folders (where `claude auth status` says they are). It is opened read-only and read up to the size it had when NVX Ancile looked, so a session being written is read as it was a moment ago; a half-written last line waits for the next read.
- Each line is one entry. Entries link by `uuid` and `parentUuid`. A compaction writes a boundary entry with no parent and a `logicalParentUuid` pointing at the last entry before it, so the conversation is joined back across it. The latest entry ends the active path.
- Parallel tool calls look like branches in the file (each call is its own entry, and each result hangs off its own call); they are folded back into the answer they belong to. Any other fork (a new prompt or answer after a rewind) is a branch.
- A prompt typed while Claude Code was working is kept as your message. Subagent entries are left to the SDK's subagent reading.
- Lines it does not understand are skipped and counted. If more than 2% are not understood, or the file is missing, or (when a thread is first built or rebuilt) the reader does not hold everything the SDK returns, NVX Ancile falls back to the SDK's chain for that session and says so in its log.

NVX Ancile never writes to these files.

### The SDK and the bridge

The SDK is Anthropic's (all rights reserved), so NVX Ancile does not ship it. The first time you use Claude Code from NVX Ancile, the **Claude bridge**, a small separate program that comes with NVX Ancile (MIT licence), downloads the one SDK version NVX Ancile is tested with from npm (`registry.npmjs.org`), checks its checksum before unpacking it, and keeps it in NVX Ancile's data folder (`claude-bridge/claude-sdk`). You get the SDK from Anthropic, under Anthropic's terms (code.claude.com/docs/en/legal-and-compliance). Core talks to the bridge over a private connection on this computer only.

Turn **Claude Code usage reporting** off to set `DISABLE_TELEMETRY` for the Claude Code that NVX Ancile runs.

## Limits in this release

- The folder recorded is the one Claude Code gives for the session; a session that moved folder part-way through (`/cd`) shows its current folder only when Claude Code reports it. TODO(phase-3): follow folder changes within a session.
- A fork made in NVX Ancile keeps the message ids it shares with its session, so it hangs off the thread as a branch. A fork made in a terminal (`/branch`) still comes in as a thread of its own. TODO(phase-3): bring terminal forks in as branches of the thread they came from.
- A slash command sent from NVX Ancile is written by Claude Code under its own id, so it may show once as you typed it and once as the command chip after the turn. TODO(phase-3): match a sent command to Claude Code's entry for it.
- A session is "open elsewhere" when its file was written by another process in the last minute; one open in a terminal but idle for longer is not detected. TODO(phase-3): ask Claude Code itself whether a session is open.
- A hosted MCP server added while a session is open reaches it on the session's next start (the MCP server for sessions does not push tool changes yet).
- Images in a message sent from NVX Ancile are not passed on yet. TODO(phase-3): attachments in live turns.
