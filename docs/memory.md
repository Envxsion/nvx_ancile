# Memory

Ancile remembers what you tell it, what it learns from your corrections, and what went wrong before. That memory is plain markdown in a git repository at `data/memory/`. You can read every line, edit it, see when and why each line was written, and undo any change.

## The files

| File | What it holds | Written by |
|---|---|---|
| `AGENTS.md` | House rules for every model | You only |
| `USER.md` | Your preferences | Corrections you make, and you |
| `PROJECTS/<notebook>.md` | A notebook's goal, decisions, findings and open questions | Notebook threads, and you |
| `FAILURES/<topic>.md` | Lessons from things that failed and were then fixed | Runs that recovered |
| `MODELS/<model>.md` | Quirks of a particular model | Usage statistics |

New kinds of memory are added in `config/memory.yaml`; no code is needed.

## What an entry looks like

```markdown
- Use British spelling in prose and code comments. <!-- m:01J9Z3 conf:0.92 src:msg_01J9YX at:2026-10-07 -->
```

One bullet per idea. The comment trailer is invisible when rendered and lets Ancile link the entry to the message it came from. Lines you write without a trailer are fine: Ancile indexes them as they are.

When a preference changes, the old entry moves under `## Superseded` with a pointer to the new one. Nothing is silently deleted, so "what did it believe before, and when did that change?" always has an answer.

## How it learns

- **Corrections.** You say "no, use metric units", or edit and resend a message, or give a thumbs-down with a comment. Ancile decides whether that's a lasting preference or a one-off fix. Lasting preferences become an entry in `USER.md`, or in the notebook's file if they're specific to it.
- **Failures.** A task fails, then succeeds. The lesson goes into `FAILURES/<topic>.md`: symptom, cause, fix, and how to recognise it next time.
- **Findings.** When a notebook thread goes quiet, its conclusions and decisions are appended to the notebook's project file, linked to their messages.
- **Model quirks.** Repeated refusals or format failures for one model are noted in its file.

Before writing, Ancile compares the new entry with the closest existing ones. It then adds the entry, updates one, supersedes one, or does nothing. That's what keeps the files from filling with near-duplicates.

**Applied or proposed?**
- Confident changes (≥ 0.85 for preferences) are applied, and a toast offers **Undo**.
- Less confident ones wait in **Memory → Inbox** for you.
- Anything prompted by content from a tool, web page or source is *always* a proposal. A document can't write itself into your memory.

## How it's used

Before every model call, Ancile builds a memory block:

1. `AGENTS.md` and `USER.md`, always.
2. The notebook's project file, when you're in a notebook.
3. The five failure lessons most relevant to what you just asked.
4. The quirks file for the model that's actually answering, chosen after any fallback.

Memory gets at most 8% of the model's context window, capped at 4,000 tokens (configurable per notebook). When it doesn't all fit, whole entries are dropped by priority, then confidence, then age, never mid-sentence. The block tells the model these are notes, not orders, and that your current request wins.

To see exactly what will be injected before you send, open **Memory → Preview** from the composer menu. After a reply, the "why" panel lists the files, the commit and the entries that were used.

## Every change is a commit

```
memory(user): prefer British spelling

From thread "Grant draft" (thr_01J9…), message msg_01J9YX.
Detected: correction · confidence 0.92 · auto-applied
Ancile-Proposal: mpr_01J9Z3
```

- **History:** Admin → Memory shows each file's history, a diff between any two versions, and **Revert**, which makes a new commit.
- **Conflicts:** if Ancile commits while you're editing a file, your save is merged automatically when the edits don't overlap. When they do, you see both versions side by side. See the [memory conflict runbook](runbooks/memory-conflict.md).
- **Deleting a file:** **⋯ → Delete file** in Admin → Memory removes it in its own commit (`DELETE /api/v1/memory/files/<path>`, through the memory module like every other write). History keeps it, so **Undo** on the notice reverts that commit and the file comes back. AGENTS.md, USER.md and the folder's guides (`README.md`, `_template.md`) can't be deleted (`memory.protected`).
- **Backup:** set `remote` in `config/memory.yaml` (or `ANCILE_MEMORY_REMOTE`) to push to a private git remote on a schedule.

## Editing by hand

You can also edit `data/memory` with any editor and commit with git. Ancile re-indexes on change. Keep entries as single bullets and leave the trailers alone, and everything keeps working.
