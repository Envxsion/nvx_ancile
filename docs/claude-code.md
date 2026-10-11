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

## How sessions look in a thread

- Your prompt is your message. Everything Claude Code did in answer (its thinking, each tool call with its result, and its reply) is one answer, so tool calls sit next to their results.
- Where Claude Code compacted the conversation, a divider reads "Conversation compacted here", with Claude Code's summary.
- A subagent (the Task tool) is folded under the call that started it; open it to read its conversation.
- Very large tool results are shortened, with a note saying how much was left out. Images up to 512 KB come in; larger ones are noted.
- If you rewound a session in Claude Code and went another way, the thread has a branch there, and the newest path is the one shown.

## How NVX Ancile reads sessions

Claude Code keeps sessions in its own files, in a format that is its own. NVX Ancile does not read those files itself: it reads them through Anthropic's Claude Agent SDK, the supported way.

The SDK is Anthropic's (all rights reserved), so NVX Ancile does not ship it. The first time you use Claude Code from NVX Ancile, the **Claude bridge**, a small separate program that comes with NVX Ancile (MIT licence), downloads the one SDK version NVX Ancile is tested with from npm (`registry.npmjs.org`), checks its checksum before unpacking it, and keeps it in NVX Ancile's data folder (`claude-bridge/claude-sdk`). You get the SDK from Anthropic, under Anthropic's terms (code.claude.com/docs/en/legal-and-compliance). Core talks to the bridge over a private connection on this computer only.

Turn **Claude Code usage reporting** off to set `DISABLE_TELEMETRY` for the Claude Code that NVX Ancile runs.

## Limits in this release

- The folder recorded is the one Claude Code gives for the session; a session that moved folder part-way through (`/cd`) shows its current folder only when Claude Code reports it. TODO(phase-2): follow folder changes within a session.
- Running sessions from NVX Ancile comes in the next release.
