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

**Your own explicit request is yours (GR3).** Say "remember that I use metric units", "never add a summary", or "from now on answer in French" and it is saved at once, in any capture mode except Off (with capture Off it waits in the inbox, so it is never lost). A note under your message says **Saved to memory** with **Undo**. The detector (`services/core/src/memory/explicit.ts`) reads only your own words: quoted lines, pasted blocks and code are ignored, and it turns away questions ("do you remember that?"), "never mind", negations ("don't remember that"), "if I say remember" and sarcasm. A request has to open a sentence, so "he said never do that" is not one. "Remember..." and "from now on..." are kept under *Preferences*, "never..." under *Restrictions* in `USER.md`, or in the notebook's file when you say "in this notebook". The rule is enforced in code, not in a prompt: `applyPolicy` honours the explicit flag only for content whose provenance is `user_message`. Text from a source, a tool or another model can only propose.

**Lessons need two sightings (proved or suggested).** A lesson learned from a run (a failure then a fix, a project finding, a model quirk) is not a rule the first time. Seen once it waits in the inbox under **Watching**, with its uncertainty written in ("Seen once. The cause is not clear, so it may be a coincidence."). Seen again, it becomes an ordinary suggestion (or is kept, if the type auto-applies), with both cases as evidence. It also skips the wait when its evidence is checked: the same fix worked at least twice in the turn and the cause is stated. A watch item that is never seen again lapses after 90 days (`WATCH_DAYS`). You can trust one early (**Trust it now**) or turn it down. What you state yourself, a correction or an explicit request, never waits.

**Where it is kept.** Approving a suggestion in the inbox or under an answer lets you choose **You** (`USER.md`), **This notebook** (the notebook the thread was in) or **Everywhere** (`AGENTS.md`), or any memory file. **This notebook** is off, with the reason, when the thread was not in a notebook, the notebook was deleted, or the thread is gone. Lessons and model quirks are kept by topic, so they offer only a file.

**Why it was learned.** Each suggestion shows how sure NVX Ancile is, the words it learned from, and **Open this turn**. If the thread has been deleted it says "Learned from a thread that was deleted" and keeps the quote.

**Hindsight pass.** In a thread's menu (Claude Code threads too), **Hindsight pass** reviews the session for root causes and separates process lessons (how to work) from environment facts (what is true of this machine or project). It only proposes: each suggestion is filed in the inbox and cites the turn it came from, and a suggestion that cites no real turn is dropped, so the model cannot invent a lesson. "Nothing worth keeping" is a valid answer. A long session is condensed first (each turn trimmed, then quiet turns left out) to 6,000 tokens. The model call is a `utility` call through the gateway, so it is costed like the others.

## How it's used

Before every model call, Ancile builds a memory block:

1. `AGENTS.md` and `USER.md`, always.
2. The notebook's project file, when you're in a notebook.
3. The failure lessons most relevant to what you just asked, up to five. **Abstain gate:** a lesson is included only if it clears the relevance bar, `RELEVANCE_BAR` in `services/core/src/memory/gates.ts` (default **0.2**, compared with the word-overlap score of the lesson and your question, 0 to 1). Before, the bar was 0.08, which let a single shared word through; on a four-word question and a twelve-word lesson one shared word scores about 0.14 (dropped) and two score about 0.29 (kept). If nothing clears it, no lessons are added and the budget is not filled with weak matches. Pinned notes (`AGENTS.md`, `USER.md`, the notebook file, the model's quirks) do not depend on the question and are unaffected. Tune the bar on an eval set before changing it.
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
- **Backup:** the **Back up memory** automation pushes your memory to a private git remote every hour. It is off until it has a remote: open it in Admin → Automations → Edit, type the remote, press **Test push** to check it can push (a dry run: nothing changes there), then **Save and turn on**. The remote can also be set in Settings → API keys, as `remote` in `config/memory.yaml`, or as `ANCILE_MEMORY_REMOTE`. A push never waits for a password: one that needs a password nobody saved fails and says so.

## Import and export

**Admin → Memory → Import and export** (the fourth tab).

**Export** makes a file on this computer and hands it to your browser to save. Nothing is uploaded.

- **Zip:** every memory file as it is now (`git archive`).
- **Markdown:** one readable file with every memory file in turn. NVX Ancile can import it back.
- **Git bundle:** the whole repository, every change and its history included (`git bundle`). Open it with `git clone memory.bundle`.

You can export all of memory or one notebook's file. A zip or Markdown export can leave private notebooks out. A bundle always holds everything, private notebooks included, so it can't (`memory.export_bundle_whole`). When an export holds a private notebook's memory, the tab and the file both say so: keep the file somewhere private.

**Import** brings in what another tool remembered. Everything comes in as a suggestion: memory only takes content from outside after you say yes.

| From | What you give it | Where it goes |
|---|---|---|
| NVX Ancile | A zip, git bundle or Markdown file that NVX Ancile exported | Each entry keeps its file and section. Superseded entries and guide files are left out. |
| Claude Code | A `CLAUDE.md` or memory file **you pick**. NVX Ancile reads only that file and never looks in `~/.claude` on its own. | About you, house rules (`AGENTS.md`) or a notebook. Headings become sections. Code blocks and `@imports` are left out and counted. |
| ChatGPT | ChatGPT doesn't document a format for exporting memory. Copy the list from Settings → Personalization → Memory → Manage and paste it, one memory per line. A JSON list of strings or of `{content}` also works. | About you, house rules or a notebook |
| Notes | Markdown or plain text, picked or pasted | Each bullet or paragraph becomes one entry, under its heading |

1. **Preview** reads the file and writes nothing. Entries already in memory, or repeated in the file, are marked and left unticked. Entries over 600 characters are cut and flagged.
2. **Add N for review** makes the ticked entries into suggestions (`kind: imported`, `provenance: import`). They wait in the import's own review, not in the inbox.
3. **Accept all**, or untick some and **Accept N ticked**. The accepted entries are written in **one commit**:

```
memory(import): 12 entries from ChatGPT memory

Imported from memories.txt (ChatGPT memory); accepted by hand: 12 of 14.
Files: USER.md.

Ancile-Import: mim_01J…
```

**Undo this import** reverts that commit, so every entry from it goes at once. A notebook whose scope switches memory writing off takes no imports (`memory.import_not_allowed`).

## Editing by hand

You can also edit `data/memory` with any editor and commit with git. Ancile re-indexes on change. Keep entries as single bullets and leave the trailers alone, and everything keeps working.
