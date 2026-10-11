# Works with Claude Code

NVX Ancile works with the Claude Code you already use. Your Claude Code sessions, from every project on this computer, appear in NVX Ancile as threads, in a notebook named after each project's folder, and they stay in step as you keep working in the terminal.

NVX Ancile uses your own installed Claude Code, unchanged. It never modifies it, never reads its sign-in files, and never sees your Claude password or tokens.

## What it does

- **Finds Claude Code.** Settings → Claude Code shows whether it is installed, its version, and whether it is signed in (the sign-in method and plan only).
- **Installs it if you want.** With **Install automatically** on (the default), or when you press **Install**, NVX Ancile runs Anthropic's official installer (`claude.ai/install`). It installs into your home folder and needs no admin rights.
- **Checks the install is Anthropic's.** NVX Ancile compares the Claude Code program with the checksum in Anthropic's release list for that version, and on Windows and macOS checks it is signed by Anthropic. An install that fails the check shows "This Claude Code install could not be verified", and NVX Ancile will not run sessions through it.
- **Brings your sessions in.** With **Import automatically** on (the default), every session comes in by itself, a little after NVX Ancile starts and whenever Claude Code writes to a session. You can also pick sessions in the list and press **Bring in**.
- **Keeps them in step.** Keep working in the terminal: new messages are added to the thread. A session open in a terminal right now is read only, never written to.

## Sign in

Signing in is Claude Code's own: press **Sign in** and Claude Code opens its sign-in in your browser, exactly as `claude auth login` does in a terminal. NVX Ancile only asks Claude Code afterwards whether it is signed in. If the window cannot open from NVX Ancile (for example on a Linux machine without a desktop), run `claude auth login` in a terminal.

You do not need to be signed in to see and bring in sessions: they are already on your computer. **Sign out** runs `claude auth logout`, and only when you press it.

Claude Code's usage counts against whichever account Claude Code is signed into (your Claude plan, or API billing), exactly as in the terminal. NVX Ancile shows token counts from your sessions but no prices.

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
- What Claude Code itself wrote on your side of the conversation is not shown as if you typed it:
  - **Commands you ran** (`/model opus`, or `!git status` in shell mode) are one message showing the command, with what it printed folded into it (colour codes removed).
  - **Notifications** are shown as notes, not as your words: a background task that finished or failed (with its result), a message from another Claude Code session ("Message from nvx_folio"), and an agent's report.
  - **Interruptions** ("[Request interrupted by user]") read "Stopped by you".
  - Claude Code's notes to the model (`<system-reminder>`) and its caveat before local commands are left out.
- Where Claude Code compacted the conversation, a divider reads "Conversation compacted here", followed by Claude Code's summary of what came before, as a note.
- A subagent (the Task tool) is folded under the call that started it; open it to read its conversation.
- Very large tool results are shortened, with a note saying how much was left out. Images up to 512 KB come in; larger ones are noted.
- If you rewound a session in Claude Code and went another way, the thread has a branch there, and the newest path is the one shown.

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

When the mapping changes, `MAPPER_VERSION` (services/core/src/claudecode/map.ts) goes up. The next import pass rebuilds every thread made by an older version, keeping the thread, its title, notebook and place in the list, as long as the thread holds only messages from Claude Code. A thread you wrote in from NVX Ancile is kept as it is; only new messages use the new mapping.

## How NVX Ancile reads sessions

Claude Code keeps sessions in its own files, in a format that is its own. NVX Ancile does not read those files itself: it reads them through Anthropic's Claude Agent SDK, the supported way.

The SDK is Anthropic's (all rights reserved), so NVX Ancile does not ship it. The first time you use Claude Code from NVX Ancile, the **Claude bridge**, a small separate program that comes with NVX Ancile (MIT licence), downloads the one SDK version NVX Ancile is tested with from npm (`registry.npmjs.org`), checks its checksum before unpacking it, and keeps it in NVX Ancile's data folder (`claude-bridge/claude-sdk`). You get the SDK from Anthropic, under Anthropic's terms (code.claude.com/docs/en/legal-and-compliance). Core talks to the bridge over a private connection on this computer only.

Turn **Claude Code usage reporting** off to set `DISABLE_TELEMETRY` for the Claude Code that NVX Ancile runs.

## Limits in this release

- The folder recorded is the one Claude Code gives for the session; a session that moved folder part-way through (`/cd`) shows its current folder only when Claude Code reports it. TODO(phase-2): follow folder changes within a session.
- Running sessions from NVX Ancile comes in the next release.
- Claude Code gives NVX Ancile a session's current conversation only, so a rewind inside Claude Code (Esc Esc) shows as a branch only if NVX Ancile synced the earlier path before you rewound. After a compaction, it gives the conversation from the summary on.
- A forked session (`/branch`, or the SDK's `forkSession`) comes in as a thread of its own: on the sessions measured, no message ids were shared between sessions, so there is nothing to hang a fork off as a branch. TODO(phase-2): bring forks in as branches if Claude Code records where they came from.
