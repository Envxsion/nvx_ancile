# Notebooks coming together: merge, context links and context packs

Three ways to bring context from one place into another, from the most permanent to the lightest:

| | What it does | Moves anything? | Edition |
|---|---|---|---|
| **Merge** | Notebook B joins notebook A for good (undo for a week). | Yes | Free |
| **Context link** | A thread or notebook reads another notebook's sources, or another thread's summary. | No | Free |
| **Context pack** | A saved bundle (sources, notes, a summary, memory, instructions) attached anywhere in one click, and shared as a signed file. | No | Pro |

All three keep to [scopes](scopes.md): nothing reaches a place it could not reach on its own.

**What a question can use from a source.** Each source in a notebook has a level, in the Sources panel: **Passages** (stored as `full`), **Summary** (`insights`) or **Off**. Passages means each question searches the source and the passages that match it best go with the question and can be cited; the whole source is never sent at once, whatever its size. Summary sends only the source's summary; Off keeps the source in the notebook and out of answers. (The level was labelled "Full" before 0.1.0, which read as if the whole source went to the model.)

## Merging notebooks

Open a notebook's menu and choose **Merge a notebook into this one**, or choose **Merge notebooks** where NVX Ancile notices two notebooks are one repository ([Claude Code](claude-code.md#one-repository-in-two-folders)).

### Preview first

`GET /notebooks/:id/merge-preview?from=<notebook id>` says everything the merge would do and changes nothing:

- **Threads** that join, each keeping its own history and its own Claude Code folder.
- **Sources** (the knowledge service's half): B's sources that join A; those already in both (nothing to do); **duplicates**, a source of B's with the same content hash as one of A's, which is merged into A's copy; and **other versions**, the same address or title with different content, where both are kept.
- **Notes** that join, and **notebook memory**: B's entries in `PROJECTS/<b>.md` are added to A's file under "Merged from B", in one commit through the memory module.
- **Flows** that join (switched off when A already has an active flow: one active flow per notebook).
- **Instructions and persona** of both. You keep A's, take B's, or combine them (the dialog fills in both, and you edit).
- **Scope**: every field that differs, its value in each notebook and in the merged one, and whether it narrows A or B.
- **Claude Code folders**: after the merge A holds them all. A thread keeps the folder it was made in.
- **Context links** to or from B, which will point at A; a link between A and B would point at A itself, so it goes.
- **Remembered approvals** scoped to B are left behind, so nothing is allowed in A that was not before.

### The scope only narrows

The merged notebook takes the narrower value of every scope field, and **private wins**:

- Switches (`data_leaves_machine`, `context_links`, `memory_read`, `memory_write`, `network`) are on only if both notebooks have them on.
- Deny lists (`models_deny`, `tools_deny`, `mcp_servers_deny`) are everything either blocks.
- Allow lists (`engines`, `models_allow`, `tools_allow`, `mcp_servers_allow`, `folders`) keep only what both allow (an unset list allows anything).
- `sources` is the one exception, because each list names that notebook's own sources: each notebook keeps its own limit on its own sources, and the list stays unset only when both are.
- A **tool preset** chosen on both, and different, keeps A's as the notebook's preset and folds B's rules into the notebook's own tool fields, so both keep applying.
- If either notebook is private, the merged one is private: local models only, nothing leaves this machine.

Code: `services/core/src/scopes/combine.ts` (`mergeScopes`).

### Apply

`POST /notebooks/:id/merge {from_id, instructions}`:

1. The knowledge service moves B's source links to A and merges duplicates (`POST /kn/v1/notebooks/:id/merge`). A duplicate in no other notebook is removed in favour of A's copy.
2. B's notebook memory is added to A's (one commit).
3. Core's half runs in **one transaction**: threads, notes, flows, Claude Code folders and links move; B's "sent before it became private" history is copied to A; A takes the merged scope and the chosen instructions; a **tombstone** is written for each merged duplicate (`reason 'merged'`, `merged_into` A's copy), so answers that cited it still name it and say where it went; B is soft-deleted with `merged_into`; and a merge record is kept.

If a later step fails, the earlier ones are put back: nothing is half merged.

### History and undo

A merge is kept in `core.notebook_merges` with everything it moved and what A held before. The notebook shows **Merged here** with **Undo merge** for 7 days (`POST /notebook-merges/:id/undo`): threads, notes, flows, folders, links, scope, instructions, tombstones, B's sources and A's notebook memory all go back. A thread made in A after the merge stays in A.

### For other parts of NVX Ancile

`NotebookMergeService` (`services/core/src/notebooks/merge.ts`) is the one entry: `preview(intoId, fromId)`, then `apply(intoId, { from_id, instructions })`, and `undo(mergeId)`. The same-repository suggestion sets `can_merge` from it.

## Context links

A thread or a notebook can draw on:

- **another notebook's sources** ("this thread can read notebook X's sources"), or
- **another thread's summary** ("this thread can see thread Y's summary": its newest TL;DR or compaction summary, or, before it has one, a short digest of its latest turns).

A link made on a notebook applies to every thread in it. Links are directional and listed on both ends (**This thread reads from**, **Reads from this thread**). Open them from a thread's or a notebook's menu: **Context links**.

### Every read passes both scopes

When a link is made, and again every time it is read, NVX Ancile checks the reading side's scope and the linked side's (`checkLinkRead` in `scopes/combine.ts`):

- The reading side must allow context links (`context_links`, `scope.context_links_off`).
- A **private** notebook, or one that keeps data on this machine, can only be read where nothing leaves this machine either (`scope.private_notebook`, `scope.data_stays_local`). A thread whose answers may come from a cloud model cannot link it, whichever model happens to answer: a fallback could be a cloud one. Claude Code never reads it.
- The linked side may not allow fewer engines or models than the reader (`scope.engine_not_allowed`, `scope.model_not_allowed`).
- Only the sources the linked notebook's scope lets retrieval read are searched.

A link refused when it is made answers 403 with the scope's own code. A link that a scope refuses later (the notebook was made private since) stays listed with the reason, and is not read until the scopes allow it again.

### Where links are read

- **The conductor's retrieval** (`conductor/links.ts`): the thread's own notebook and every linked notebook are searched side by side, ranked together, and capped per source as one search is. A linked passage says which notebook it is from, in the passage the model reads, in the retrieval trace (`hits[].via`) and in its citation (`citation_ref.notebook_id`, `notebook_title`). A thread outside any notebook can read linked notebooks too. Linked thread summaries are given as context, marked as not instructions.
- **Claude Code's search tool** (the `ancile` MCP server): `search` reads linked notebooks too, checked for Claude Code as the reader, and a linked passage's title names its notebook. `read_source` reads a linked notebook's source.
- **The Why view** lists every link (and context pack) a turn considered: used (with passages and citations), nothing matched, or not read and why.

## Context packs (Pro)

A context pack is made from one notebook or thread: chosen sources (kept by id, and searched in the notebook they came from, with citations), notes, a thread's summary, memory entries and instructions (copied in). It attaches to a thread or notebook in one click, and every turn there reads it.

- **Scopes.** A pack remembers where its items came from. Attaching it, and every turn that reads it, passes the same check a context link does. A pack made from a private notebook, or one that keeps data local, is **local only**: it attaches only where nothing leaves this machine, and stays local only through export and import.
- **Files.** Export gives a file with a manifest (each item's kind, title, size and sha256) signed with this computer's Ed25519 key. Importing shows what is inside, who signed it (a key fingerprint, or "this computer") and whether it verifies; a file that does not verify is never added. A pack's sources are added as text sources to a notebook you choose.
- **Free build.** Every `/api/v1/pro/context-packs` route answers 402 `pro.feature_required` (feature `context_packs`), and Admin → Context packs shows what it does.

The public repository holds only the seam: the contract (`packages/contracts/src/packs.ts`), `ProPackHost` and the `turnContext` hook (`services/core/src/pro/types.ts`, `pro/packs.ts`), the 402 routes and the locked screen.

API: [api.md](api.md#notebook-merge-and-context-links). Errors: [errors.md](errors.md#notebooks-and-context-links).
