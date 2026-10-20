# Permissions

Ancile asks before it acts, but only as often as it needs to. Every tool action falls into one of three tiers:

| Tier | Examples | Asks | Remembers |
|---|---|---|---|
| **Auto** | Read a file in the workspace, search your sources, count words | Never | Nothing to remember (but every call is logged) |
| **Gated** | Write a file, fetch a URL, start a GPU node | The first time for a pattern | Yes, as a saved permission with a scope and optional expiry (Admin → Permissions) |
| **Critical** | Delete, send email, terminate a node, write outside the workspace, run a shell command | Every time | Never. The dialog has no "remember" option. |

Saved permissions and decisions are stored in Postgres, so they survive restarts.

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

**A pattern of my own** takes any pattern from the [grammar below](#patterns). The (i) beside it opens worked examples inside the dialog (choosing one fills the field), and a line under the field says whether the pattern matches the request in front of you. Core uses the same matcher, and only saves a pattern that matches the request and is no wider than the tool allows.

### Several requests at once

When more than one request is waiting in a thread (Claude Code often fetches two pages and runs a search together), the dialog shows how many ("3 waiting") and lists the others. Each can be allowed once, declined, or opened in full from the list. **Allow all** and **Decline all** answer the lot; with a remembered pattern, Allow all saves your answer on the request in front of you first, then allows the rest once. Critical requests are never allowed in bulk.

Saving a remembered answer settles the other waiting requests it covers. Core does not take the pattern's word for it: each one is decided again by the gate, on its real arguments, so a policy, a floor or a critical tier still asks. In the thread, every "Waiting for your decision" step opens its own request.

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
| Fetch a page | `http:https://api.github.com/repos/x/y` | `http:https://api.github.com/**` or `web:api.github.com` |
| Web search | `web:search/<query>` | `web:search` |
| Shell | `shell:git status` | `shell:git status*` |
| MCP tool | `mcp:github/create_issue` | `mcp:github/*` |
| Compute | `compute:node/nod_01J9…` | `compute:node/*` |

`*` matches one path segment and `**` any number. Actions match the same way: `fs.*`, `mcp.github.*`. A remembered answer covers the action it was asked for, except site rules (below).

**Shell.** A wildcard matches any text, slashes included, but never `;` `&` `|` `` ` `` `$` `<` `>` or a line break. So `shell:git status*` covers `git status --short` and never `git status; rm notes.md`. Commands that look dangerous are critical anyway, and critical is never remembered.

**Site rules** (`web:…`) are for searching and fetching only. One rule covers both web searches (`web.search`) and page fetches (`web.fetch`), so its grant's action is `web.*`; it never covers a network write (`http.post`, …) or a shell command.

| Pattern | Covers |
|---|---|
| `web:*` | every web search and every website |
| `web:search` | every web search, no fetches |
| `web:fetch` | every fetch, any website, no searches |
| `web:example.com` | pages on example.com only (not www.example.com) |
| `web:*.example.com` | example.com and every subdomain (docs.example.com, a.b.example.com) |
| `web:example.com/docs/**` | /docs and everything below it on example.com (the query string is ignored) |
| `web:search/<query>` | that one search, word for word |

A host is matched exactly and lowercase; `example.com:8080` matches that port only. Before October 2026 a search was `web:<query>`; old exact-search grants still match that one search.

### Worked examples

| To allow | Pattern |
|---|---|
| All web searches | `web:search` |
| All fetches | `web:fetch` |
| All websites, and searches | `web:*` |
| One site | `web:example.com` |
| A site and its subdomains | `web:*.example.com` |
| A path on a site | `web:example.com/docs/**` |
| All files under a folder | `fs:/workspace/notes/**` |
| One command and its options | `shell:git status*` |
| An MCP server's tools | `mcp:github/*` |

To **deny** instead, choose the pattern and a Remember scope, then press Decline and remember: matching requests are refused without asking, and a deny beats an allow that is just as specific. **Remember** sets where it applies (just this once, this thread, this notebook, or always) and **Expires** ends it sooner. Every example is checked against the matcher in `apps/cockpit/test/approvalPatterns.test.tsx`.

Remembered answers never get past a hard floor: a policy `forbid`, a scope, an MCP tool that changed, a critical tier, and in Auto mode the floors (a key or password in the call, a lot of data inside a web address, …) are all checked before grants.

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

## Tier floors

- An action marked `destructive` can never be auto. A plugin manifest that declares one fails validation.
- Lowering a critical action to gated asks you to type the action name to confirm, and the change is logged.

## Admin views

- **Permissions:** every saved permission (a *grant* in the API: `GET /grants`) with its pattern, scope, uses, last use and expiry. One past its expiry no longer counts at the gate; it stays listed, marked **Expired** (a word and an icon, not colour alone) with how long ago, until you revoke it or give it a new expiry with **Edit**. **Show** filters the list: All, Active or Expired, each with its count. Its "⋯" menu edits or revokes it. A revocation takes effect on the very next check. The page was called Grants; `/admin/grants` still opens it.
  - **Edit** narrows the pattern, changes where it applies, or sets a new expiry (which also brings an expired one back). A pattern can only narrow: the new one must sit inside the old (`fs:/workspace/**` → `fs:/workspace/docs/*.md` is fine; the reverse, or bringing in a `**` the old one lacked, is refused with `permission.pattern_too_broad`). To allow more, revoke and answer the next request. A new scope takes its thread or notebook from the approval it came from; under Careful a scope can narrow but never widen past one thread.
  - **Revoke** asks first, then shows an Undo for ten minutes (`POST /grants/:id/restore`). After that the revocation stands and the agent asks again.
- **Decisions:** the latest 200 decisions: when, what, on what, the outcome and its tier (`GET /permissions/decisions?limit=`; it was `GET /decisions`, which now answers the decision layer's status, see [decisions.md](decisions.md)).

## Path confinement (SC1)

Permission checks resolve links on the path they are given (`normalizeFsPath`), but a link from one lab or notebook folder into another is still inside the workspace. So the places Core writes files for an agent confine again by real path (`services/core/src/files/confine.ts`) against the roots that agent may use, at execution time:

- `fs_read`, `fs_list`, `fs_write` and `fs_delete` (`tools/builtin/fs.ts`), the editor's save (`files/service.ts`) and the lab's undo (`lab/snapshot.ts`).
- The lab's own edits, writes and patches (`lab/confine.ts`, called by the permission bridge before anyone is asked): the real path must be inside that lab's folder and not a link; a request to leave the folder that lands in another lab is refused.

A symlink, a Windows junction, `..`, a dangling link, or a link as the last part of a write, rename or delete is refused with `fs.path_escape`. Windows compares paths without case. Writes open without following a link where the OS has `O_NOFOLLOW`, then check the same path and the open file's device and inode again before writing. What is not covered: a shell command the lab runs (it stays CRITICAL and is decided on the command), and a folder swapped for a link in the instant between checking a rename or delete and doing it.
