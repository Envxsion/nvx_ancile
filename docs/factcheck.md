# Fact-checking and confidence

Any answer can be checked claim by claim against your sources, and optionally the web, by a second model that didn't write it.

## Using it

- Press `f` on a message, or **Fact-check** in its hover actions.
- Or **highlight any words** in any message (a model's answer or your own; prose, LaTeX, code, a link) and choose **Fact-check** on the bar beside them, in the context menu or with `f`. See [Checking a highlighted claim](#checking-a-highlighted-claim).
- In a notebook with **grounded mode** on (Notebook settings), every answer is checked automatically, and any answer without citations is flagged "not grounded in your sources".

Each checked claim is underlined in place:

| State | Mark | Meaning |
|---|---|---|
| Verified | faint green dotted underline, ✓ icon | Your evidence supports it, and nothing credible contradicts it |
| Unverified | grey dotted underline, ? icon | Not enough evidence either way |
| Contradicted | red wavy underline, ! icon | Evidence says otherwise. A warning shows both sides. |

Icons go with the colours, so the state never depends on colour alone. Hover or focus a claim to see the evidence: the source excerpt highlighted, and both sides for contradictions. Click through to open the source at that passage.

## How it works

1. **Find the claims.** A small model splits the answer into atomic, checkable claims (numbers, dates, names, causal statements) and skips opinions and advice. Each claim keeps its exact position in the text.
2. **Gather evidence.** Your notebook's sources are searched first (hybrid search, then reranking). Claims they do not cover are looked up on the web when the notebook's **Check on the web** is on (or you allow it for one check) and the notebook may use the web (see below). Web results are titles, links and snippets, wrapped as untrusted content; each piece of evidence is marked **Source** or **Web**.
3. **Verify with the right amount of model.** Each claim is triaged by plain rules (`services/core/src/factcheck/triage.ts`), and the decision layer may raise a tier but never lower one:
   - An **obvious** claim (short, no numbers, no names, such as "the sky is blue") goes to a **tiny** model. With no source covering it, the tiny model judges from common knowledge, the claim shows **verified** at a modest 70% confidence, and the card says so. A tiny model is the only checker only for a claim like this, and never in a critical notebook.
   - A claim with **numbers, dates, citations, or legal, medical or financial wording**, a long or many-part claim, a claim you marked critical, and every claim in a critical notebook go to a **standard** model or better.
   - Everything else goes to a **small** model.
   The model is the best ready one of that tier in any provider, from **a different family than the one that answered** when one is ready. If only the writer's family is ready, the check **still runs** and the claim's tooltip says so; there is no "no second opinion" stop. A check of your own words has no writer.
   A claim goes **up one tier** when the model is unsure (under 60%) or contradicts the answer, and again if needed, **twice at most**. The tooltip shows the tier, the model and where it started. A claim no source covers and that is not obvious is left unverified without asking a model.
   **Checked earlier.** A verdict is kept with the claim, the sources' fingerprints and the mode. Asked again, an unchanged claim against unchanged sources is answered from the cache without a model, and the card shows "Checked earlier (date, model)" with **Re-check**. Source-backed verdicts last until a source changes; web-only verdicts a week; common-knowledge verdicts 90 days. Verdicts stay **in the notebook** that made them. **Share checks with other notebooks** (in the notebook's sources panel) lets a claim checked without your own sources answer the same claim elsewhere, and the other way round; switching it off withdraws them. Checks against your own sources never leave the notebook, and a private notebook shares only when Settings → Private notebooks allows it.
   **Mission-critical.** Turn on **Mission-critical checks** for a notebook, or ask for one check, and every claim is checked by two standard or frontier models of different families, and counts only if both agree. If two such models are not both ready, **nothing runs**: the panel lists every ready chat model, the writer's provider included ("Sonnet writes, Opus checks" is fine), suggests two, and runs the check on the ones you pick ("Check with these"). A pick below standard tier is allowed and noted.
4. **Score.**

**When no model is set up for a step.** Nothing needs listing: fact-checking asks for a tier, and any ready chat model in any provider can serve (`want` in `config/routing.yaml`). Claude Code's models and Ollama models you pulled count like any other, so a machine with only Claude Code signed in checks facts too. Only when no chat model is ready at all does it stop, with `routing.no_chat_model` ("Add a key in Settings → Keys").

**Claude Code judges at once.** Claims are checked four at a time, but every Claude Code judge call (the fallback above, or a `claude-code/<model>` you set for a step) is a Claude Code session on your Claude plan, so at most **Fact-check judges at once** of them run together across every fact-check (Settings → Claude Code, 1 to 4, default 1); the rest wait their turn. Each is asked on its own, never inside another model's fallback, and its 90-second limit starts when its turn comes. Stopping a fact-check gives up its place in the queue. The Evidence panel says "Claude Code judges run on your Claude plan" when one judged.

## The confidence score

For each claim:

```
support    = how strongly the evidence backs it, weighted by reranker score
agreement  = 1 if the verifier agrees, 0.5 if evidence is insufficient, 0 if it contradicts
retrieval  = quality of the evidence found: top reranker scores × how much of the claim it covers

confidence = 0.5 × support + 0.3 × agreement + 0.2 × retrieval
```

The message score is the importance-weighted average across claims: claims the answer depends on count most. Hovering the score explains it in words, for example: "Strong support from 2 sources; verifier agrees; evidence covers most of the claim." Weights and thresholds are in `config/factcheck.yaml`.

### Worked example

> "Trial B's dropout rate was 31%, the highest of the three."

- **Evidence:** "Attrition in Trial B reached 31.2% by week 24" (rerank 0.94) and "Trial C … 34% discontinued" (rerank 0.88).
- **Claim 1** ("Trial B's dropout rate was 31%"): supported. support 0.94, agreement 1, retrieval 0.9, so confidence 0.95. **Verified.**
- **Claim 2** ("the highest of the three"): contradicted by Trial C's 34%. confidence 0.18. **Contradicted.** Both quotes are shown.

## Checking a highlighted claim

Highlight words in a message and a small bar offers **Fact-check** (a long press, a drag, Shift and the arrows, or the context menu; `f` while words are highlighted). A card opens beside the words, which stay marked while you read it:

- **A verdict in one line**: Holds, Partly holds, Doesn't hold or Can't tell, in a status colour (never signal violet) with an icon and the word.
- **The corrected claim**, when it does not hold.
- **Three to five dot-point evidence lines**, each with its source and a label: **Source** (your notebook, first), **Sandbox run**, **Web** or **Model knowledge**.
- **One closing line** on how the surrounding answer would change if the corrected claim were the starting point.
- The cost and who checked, in the footer. A check costs money only when you press the button.
- **Copy**, **Open in Evidence** and **Use the corrected claim**, which writes a follow-up in the message box and never sends it.

It is never an essay: the judge is asked for a small JSON object with at most 700 tokens, lines are trimmed (220 characters each, the closing to one sentence), and a reply that runs on, says nothing or gives no correction for "doesn't hold" is thrown away for the next model. The highlight, the surrounding conversation and the evidence reach the judge inside the untrusted wrapper.

- **Whose family.** For a highlight in an answer, the judge differs in family from the model that wrote that answer. For a highlight in your own message, any family may judge. The judge also follows the notebook's scope: in a private notebook, or where nothing may leave the machine, only a local model judges (`factcheck.judge_not_allowed` says so when none is).
- **What it is.** Prose is checked against the notebook's sources. **Code** is checked against what is known and, where safe, by running it: only Python, only when the permission gate already allows `code.run` (a standing grant or Auto mode; a check never asks), in the existing sandbox and only with a Cockpit window open. Otherwise the card says "Not run" and why. **LaTeX** is checked as mathematics. A **link** is not opened: the check judges what the surrounding text says it shows.
- **Several claims in one highlight** are judged together ("Partly holds" when some hold and some do not, with the lines naming which). Up to 2,000 characters. A highlight in an answer still being written waits until it is done. The same highlight checked twice is answered from the record; **Check again** asks again.
- **Kept.** Each check is recorded on its message (`provenance.selection_checks`), so it survives a reload, is listed under **Highlighted claims** in the Evidence tab and appears in the receipt's **Worth knowing**.

## The web (FC4)

**Check on the web** is a switch per notebook (Sources panel), off by default; **Check again with the web** allows it for one check. It is also on for every notebook when `web_search: true` is set in `config/factcheck.yaml`. Needs `SEARXNG_URL` (a SearXNG address, [configuration.md](configuration.md)).

- A **private notebook, or one where nothing may leave the machine,** never uses the web, whatever was asked; neither does one with the network off or `web.search` blocked. The check says why on its card and in the Evidence tab.
- Each search goes through the permission gate on its real query (`web.search`, `web:search/<query>`). If the gate would have to ask, the check carries on without the web, never stalls. At most 8 claims of a check are looked up, only those the sources cover least, with 3 results each. A search that fails costs the check nothing.
- Web and source evidence are shown side by side, so when the web contradicts your own sources you see both.

## Citations during generation

Before a model answers in a notebook, each retrieved excerpt gets a marker, and the model is asked to cite with it (`[^3]`). Ancile then checks every citation: the marker must exist and the quoted text must overlap the excerpt. Invalid citations are removed and counted in the trace, so you never see a link to something that doesn't say what's claimed.

## When sources are removed or change

Every check of an answer is kept. When you check an answer again, the score before is shown beside the new one ("Was 84%"), and if the sources behind that earlier score have since been deleted, merged away or read again with different text, a note says so: "Sources changed since: 1 removed." A drop in score after a source went is explained, not alarming. `GET /messages/:id/factcheck` carries it as `previous`.

Citations hold up the same way. Each citation keeps the passage it quoted, its source's title and a sha256 of the whole passage as the model was given it. If the source is deleted, the chip reads **Source removed** and the quote is still there to read (Core keeps a tombstone with the source's name and date, so this holds even after the knowledge service purges the source). If the source is read again (a page edited, a file replaced) and the passage is no longer there word for word, the chip reads **Source changed since cited**. When the same words simply moved to another passage, nothing is flagged. A citation that cannot be checked (the knowledge service is down) is left as it is, never flagged.

## Limits

- The verifier sees only the evidence found. If your sources don't cover a claim, the best possible result is *unverified*, never *verified*.
- Web evidence is only as good as the snippets found (pages are never opened, so a dead link costs nothing), and it's treated as untrusted content.
- The score is a guide to where to look, not a guarantee.
