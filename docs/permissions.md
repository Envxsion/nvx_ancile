# Permissions

Ancile asks before it acts, but only as often as it needs to. Every tool action falls into one of three tiers:

| Tier | Examples | Asks | Remembers |
|---|---|---|---|
| **Auto** | Read a file in the workspace, search your sources, count words | Never | Nothing to remember (but every call is logged) |
| **Gated** | Write a file, fetch a URL, start a GPU node | The first time for a pattern | Yes, as a **grant** with a scope and optional expiry |
| **Critical** | Delete, send email, terminate a node, write outside the workspace, run a shell command | Every time | Never. The dialog has no "remember" option. |

Grants and decisions are stored in Postgres, so they survive restarts.

## What the approval dialog offers

When an agent wants to write `/workspace/notes/2026/trial-b.md` for the first time, you see:

```
Allow the assistant to write a file?
  /workspace/notes/2026/trial-b.md

  For:   ○ This file only
         ● /workspace/notes/2026/**
         ○ /workspace/notes/**
         ○ /workspace/**            [edit pattern]

  Until: ○ Just this once  ○ This thread  ● This notebook  ○ Always     Expires: never ▾

                                        [ Deny ]  [ Allow ]
```

Suggestions go from narrowest to widest, and the narrowest is pre-selected. After you approve `/workspace/notes/2026/**` for this notebook, later writes under that folder in this notebook don't ask.

If the model makes several calls that need approval in one step, they appear in one dialog with a toggle for each.

## How a decision is made

The check runs when the tool is about to execute, on the real arguments, never on what the model said it would do:

1. **Normalise the resource.** Resolve symlinks, reject `..` escapes, lowercase hosts, strip credentials from URLs.
2. **Policies (Cedar).** A `forbid` is a hard deny. The model is told why, and you aren't asked.
3. **Tier.** The tool's default tier, raised by any `@escalate` policy. For example, writes outside `workspace_root` become critical.
4. **Auto** → allow. **Critical** → ask.
5. **Gated** → look for a matching grant. Deny grants beat allow grants, and the most specific grant wins. A match allows; no match asks.

Every outcome is appended to the decision log with the grant, approval or policy that decided it. It appears in the "why" view and Admin → Decisions.

## Pause and resume

While an approval is pending, the run is saved and releases its worker. You can close the tab or restart Ancile, and the dialog will be there when you come back. When you answer, the run resumes from exactly that step. A denial is passed to the model as a tool result ("The user declined: …"), so it can adapt instead of failing.

Approvals raised by unattended automations expire after `ANCILE_APPROVAL_TTL_AUTOMATION_S` (default 24 hours), and expiry counts as a denial.

## Patterns {#patterns}

| Resource | URI | Pattern example |
|---|---|---|
| File | `fs:/workspace/a/b.md` | `fs:/workspace/a/**` |
| HTTP | `http:GET https://api.github.com/repos/x/y` | `http:GET https://api.github.com/**` |
| Shell | `shell:git status` | `shell:git status*` |
| MCP tool | `mcp:github/create_issue` | `mcp:github/*` |
| Compute | `compute:node/nod_01J9…` | `compute:node/*` |

`*` matches one path segment and `**` any number. Actions match the same way: `fs.*`, `mcp.github.*`.

## Presets

Chosen in setup; change them in Admin → Permissions (the row above your remembered answers).

- **Careful:** every shell command and every network write (POST, PUT, PATCH, DELETE) asks every time, and agents can't start GPU nodes.
- **Balanced** (default): reads are automatic, writes ask until you remember an answer, and shell commands that look dangerous (sudo, rm, piping into a shell) ask every time.
- **Hands-off:** writing a file inside the workspace no longer asks. Everything else is as Balanced, and an agent still can't delete a whole folder.

Whatever the preset:
- Critical stays critical. Deleting, sending, paying, terminating a node, writing outside the workspace and anything an unattended automation does ask every time.
- The approval dialog starts at "Just this once"; remembering an answer for the thread, notebook or always is your choice each time.

### Outside apps

Apps connected to NVX Ancile's own MCP server (Admin → Plugins → Connected apps) only ever read. They can search your sources, list notebooks and search memory, and only what you ticked when you connected them. No grant, however broad, lets one write, run a command or start a node. Disconnecting an app revokes its grants at once.

## Policies {#policies}

`config/policies/base.cedar` always loads. Then the active preset loads. Write your own in the same folder:

```cedar
// Never let any agent touch the finance folder.
@id("mine.no-finance")
forbid (principal is Ancile::Agent, action, resource)
when { resource.scheme == "fs" && resource.path like "/workspace/finance/*" };

// Anything posting to our internal API asks every time.
@id("mine.internal-api-critical")
@escalate("critical")
permit (principal, action == Ancile::Action::"http.post", resource)
when { resource.host == "api.internal.example.com" };
```

Admin → Permissions has a **dry run** box. It answers "what would happen if an agent tried X?", showing the policy, tier and grant that would decide it.

## Tier floors

- An action marked `destructive` can never be auto. A plugin manifest that declares one fails validation.
- Lowering a critical action to gated asks you to type the action name to confirm, and the change is logged.

## Admin views

- **Grants:** every active grant with its pattern, scope, uses, last use and expiry. Revoke, extend or narrow it. A revocation takes effect on the very next check.
- **Decisions:** the full history, filterable by tool, outcome, principal, thread or time, with links to each trace.
