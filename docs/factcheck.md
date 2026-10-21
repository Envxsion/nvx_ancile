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

1. **Find the claims.** A small model splits the answer into atomic, checkable claims (numbers, dates, names, causal statements) and skips opinions, advice and sentences about other sentences ("The first sentence contradicts the others"). Each claim keeps its exact position in the text. **The claims are kept with the answer** (and the version of the extraction that found them): checking an unchanged answer again judges the same sentences without asking a model to find them again. They are found again when the answer changed, when the extraction is newer, or when you ask (`reextract` in `POST /messages/:id/factcheck`). An answer with two or more statements is never kept as having no claims on one model's say-so: when the first reading finds none, it is asked once more, plainly, and the list is kept only when that second reading agrees. Only sentences about the answer itself are dropped; a note added after the facts does not make the facts commentary.
2. **Gather evidence.** Your notebook's sources are searched first (hybrid search, then reranking). A passage whose relevance is under **0.15** (`thresholds.relevant`) is not evidence and is dropped: relevance is 0.6 × the reranker's score (near 0 for a passage on another subject, near 1 for one that answers the claim) + 0.4 × the share of the claim's words in the passage, and an unrelated passage scores 0 to 0.05 against 0.3 and up for one on the subject. With no passage left, an obvious claim goes to common knowledge (below) and any other reads "Nothing in your sources mentions this" without asking a model. A claim they do not cover is looked up on the web by default, when the notebook may use it (see [The web](#the-web-fc4)): "Mount Everest is 8,849 metres tall" needs no source in the notebook. **The order is sources, then common knowledge, then the web.** An obvious claim no source covers ("Grass is green") is judged by a tiny model from common knowledge first and goes to the web only if that model is unsure (under 60%, or insufficient); a claim that is not obvious, or that the decision layer raised, goes to the web first. Web results are a title, a link and **text from the page** (a result with no text is dropped, never handed to a checker), wrapped as untrusted content; each piece of evidence is marked **Source** or **Web**, and a web one links the page it came from and says which route found it ("Searched with Gemini (free allowance)").
3. **Verify with the right amount of model.** Each claim is triaged by plain rules (`services/core/src/factcheck/triage.ts`), and the decision layer may raise a tier but never lower one:
   - An **obvious** claim (short, no numbers, no names, such as "the sky is blue") goes to a **tiny** model. With no source covering it, the tiny model judges from common knowledge, the claim shows **verified** at a modest 70% confidence, and the card says so. A tiny model is the only checker only for a claim like this, and never in a critical notebook.
   - A claim with **numbers, dates, citations, or legal, medical or financial wording**, a long or many-part claim, a claim you marked critical, and every claim in a critical notebook go to a **standard** model or better.
   - Everything else goes to a **small** model.
   The model is the best ready one of that tier in any provider, from **a different family than the one that answered** when one is ready. If only the writer's family is ready, the check **still runs** and the claim's tooltip says so; there is no "no second opinion" stop. A check of your own words has no writer.
   A claim goes **up one tier** when the model is unsure (under 60%) or contradicts the answer, and again if needed, **twice at most**. The tooltip shows the tier, the model and where it started. A claim no source covers and that is not obvious is left unverified without asking a model.
   **The verdict follows the checker, the number sits beside it.** If every checker says *supported* and a passage backs it, the claim is **verified**, whatever the passage's retrieval score; *contradicted* is **contradicted**; *insufficient* is **unverified**. A checker that supports a claim but says it is under 50% sure (`thresholds.verified`) leaves it unverified. The confidence below is shown beside the verdict and does not decide it.
   **Checked earlier.** A verdict is kept with the claim, the sources' fingerprints and the mode. Asked again, an unchanged claim against unchanged sources is answered from the cache without a model, and the card shows "Checked earlier (date, model)" with **Re-check**. The kept verdict carries how it was reached (the model, the tier, the tier it started at when it was sent up, what routing settled for), so the card reads the same as on the day. A re-run looks for kept verdicts first, before the decision layer sorts the claims and before the web is searched: a claim a kept verdict answers from its sources is neither sorted nor looked up. Source-backed verdicts last until a source changes; web-only verdicts a week; common-knowledge verdicts 90 days. Verdicts stay **in the notebook** that made them. **Share checks with other notebooks** (in the notebook's sources panel) lets a claim checked without your own sources answer the same claim elsewhere, and the other way round; switching it off withdraws them. Checks against your own sources never leave the notebook, and a private notebook shares only when Settings → Private notebooks allows it.
   **Mission-critical.** The check keeps every checker with its verdict (`check.checkers`) and the tooltip names both. Turn on **Mission-critical checks** for a notebook, or ask for one check, and every claim is checked by two standard or frontier models of different families, and counts only if both agree. If two such models are not both ready, **nothing runs**: the panel lists every ready chat model, the writer's provider included ("Sonnet writes, Opus checks" is fine), suggests two, and runs the check on the ones you pick ("Check with these"). A pick below standard tier is allowed and noted.
4. **Score.**

**When no model is set up for a step.** Nothing needs listing: fact-checking asks for a tier, and any ready chat model in any provider can serve (`want` in `config/routing.yaml`). Claude Code's models and Ollama models you pulled count like any other, so a machine with only Claude Code signed in checks facts too. Only when no chat model is ready at all does it stop, with `routing.no_chat_model` ("Add a key in Settings → Keys").

**Reading a model's reply.** Every prompt that asks for JSON names each field with its type and gives an example, and the call asks the provider for its JSON mode with the schema where it has one. A reply is read tolerantly first (`services/core/src/factcheck/tolerant.ts`): one wrapper key such as `{"claimVerdict": {...}}` is unwrapped, `SUPPORTED` and `true` read as supported, a confidence of `85` or `"85%"` as 0.85. A reply that still does not fit is asked again **once**, on the same model, saying what was wrong. If that fails too, that model counts as failed and the next is tried.

**Hard limits.** A check cannot run away (`limits` in `config/factcheck.yaml`; `services/core/src/factcheck/budget.ts`). Every model call counts, including a stronger second look, a repair of a bad reply and a model the gateway fell back to:

| Limit | Default | When it is reached |
|---|---|---|
| Calls per claim | 3 | the claim reads "Not checked: 3 model calls did not settle it" |
| Calls per answer (claims found included) | 20 | the claims left read "Not checked: the check reached its limit of 20 model calls" |
| Time | 6 minutes | "Not checked: the check ran out of time" |
| Spend | $0.50 | "Not checked: the check reached its spending limit"; Claude Code's plan use is not counted |

A "Not checked" claim shows as without enough evidence and the others go on; the run is never a crash. A claim that was already judged keeps its verdict when only the stronger second look was cut. Stopping a check ends it as cancelled: no model is asked after the stop, the run reads cancelled and so does the check (`status: "cancelled"`, not a failure). Every call a check makes is counted in Settings → Usage under **Fact-checks** (see [api.md](api.md), Usage).

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

A claim the notebook's sources do not cover is looked up on the web **by default**, using only the claim's own words. Nothing else of the notebook is sent, and a claim the sources cover is never searched.

| Where | What happens |
|---|---|
| A normal notebook | On. **Use the web when sources don't cover a claim** (Sources panel) switches it off for that notebook; a notebook that never touched it follows the default (`web_search: true` in `config/factcheck.yaml`), and one where it was switched off stays off. |
| A private notebook | Never, unless **Settings → Private notebooks → Fact-check on the web** (`factcheck_web`) is on ([privacy.md](privacy.md)). A search server on this computer (SearXNG) counts as leaving the machine, because it asks public search engines, so it needs that switch too. Even then the scope's other rules hold: network off or `web.search` blocked still stop it. |
| A notebook that keeps data on this machine (not private) | Never. |
| Network off, or `web.search` not allowed in the scope | Never, and the card says which rule. |

**Permissions.** A lookup of a claim goes through the permission gate on its real query (`web.search`, `web:search/<claim>`) like any other call, but a fact-check lookup is *eased*: where the gate would only ask, it allows (`eased` in `services/core/src/permissions/gate.ts`). A scope, a policy forbid, a standing "always deny" grant and the Auto mode floors are all still applied first, and chat tools keep their own rules.

| Preset | Fact-check lookups |
|---|---|
| Balanced (default) | Allowed without asking. |
| Auto | Allowed without asking, and without a reviewer call. |
| Hands-off | Allowed without asking. |
| Strict (Careful) | Asks once per check, not per claim: the web waits for **Check again with the web** (or **Check this on the web** on a claim), and that one yes covers every claim of the check. Until then the card says "Not checked on the web: Strict permissions ask first." |

An earlier version asked the gate as an ordinary gated call, so under Balanced every lookup was an unanswerable ask and the check read "Not checked on the web: the search was not allowed." That wording now means only that the person's own scope, policy or "always deny" rule forbids it.

**Where the evidence came from.** Each claim's evidence is marked **Source** (your notebook) or **Web**, and a web passage links its page. When the web was off, waiting for Strict, or failed, the claim offers **Check this on the web**: it checks that one claim, within the same permissions and daily cap, and shows the result beside the claim. Nothing is added to a claim that did not need it.

Needs a web search, which is one of these, tried in this order:

| Route | Used when | Model | Price | Free allowance | Source (checked 2026-10-20) |
|---|---|---|---|---|---|
| SearXNG | `SEARXNG_URL` is set ([configuration.md](configuration.md)) | none | free | not limited | your own server |
| Gemini with Google Search grounding | a Google key is ready | the cheapest ready Flash-Lite | $14 per 1,000 searches on Gemini 3 and newer ($35 on 2.5), plus tokens | 5,000 a month on Gemini 3 and newer; 1,500 a day on 2.5 | https://ai.google.dev/gemini-api/docs/pricing |
| OpenRouter web plugin, Exa engine | an OpenRouter key is ready | the cheapest ready OpenRouter model | $0.007 per search (up to 10 results), plus tokens | none | https://openrouter.ai/docs/guides/features/plugins/web-search |
| Anthropic web search tool | an Anthropic key is ready | the cheapest ready Claude Haiku | $10 per 1,000 searches, plus tokens | none | https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool |

A model route is one small call per claim that returns titles, links and quoted text, the same shape as SearXNG's. The model is asked to quote one to three sentences of each page; where it does not, the text the provider itself cited for that page stands in (Anthropic's `cited_text`, Gemini's grounded sentence for that site, OpenRouter's citation content). A route that fails hands over to the next, as does one that found pages but no text. A call is given 25 seconds (the model searches, then writes) and is not retried when it hangs; the rest reason then reads "it did not answer within 25 s". The model's list is read wherever it sits in the reply: inside a code fence, after a sentence, or in an object that holds the list; only a page with a quote is kept. A claim whose search found nothing quotable reads "The web had nothing quotable on this."; "Nothing in your sources mentions this." is kept for a claim the web was not used on. A Google key without billing may have no grounding quota: Google then answers 429 "You exceeded your current quota", and NVX Ancile rests the route and uses the next. The routes are tested against real replies recorded once and replayed (see [testing.md](testing.md#recorded-provider-replies-fact-check-web-routes)). A route that fails is **rested** with its reason (30 minutes for a refused key or request, 5 for anything else) and skipped meanwhile; the reason is logged and `GET /factcheck/web` shows the chain in the order it is tried, each route `ready`, `rested` (with `reason` and `rested_until`), `no_model` or `no_key`, the Gemini free allowance left, today's spend and the cap. Each lookup's route and cost are kept in the check (`scope.web_lookups`, and `via` on each piece of web evidence) and in a `web search <route>` trace span. Pages are never opened, and results are untrusted exactly as before. When none is available, the check says "Not checked on the web: no search is set up." with **Set up web search**, and never "no evidence found".

- **Cost.** What a check's lookups cost is added to the check's cost (the card's footer and the receipt) and shown on its own for a whole-answer check in the Evidence tab data (`scope.web_cost_usd`).
- **Daily cap.** Lookups through a model stop for the day once they have cost `web_daily_cap_usd` (default `0.25`, in `config/factcheck.yaml`; `0` turns them off). SearXNG is not counted. The check carries on with your sources and says "Not checked on the web: the daily web budget is reached." The day is your computer's local day.
- **Why a check may not use the web:** no search set up, a private notebook (without the setting) or one that keeps data on this machine, network off or `web.search` blocked, Strict waiting for your yes, the daily budget reached, or the search did not answer. Each is said in one line.
- A built-in search layer is planned (roadmap WB2, 0.2.0); until then these routes are the way.

- A **private notebook** uses the web only when Settings → Private notebooks allows it, and one **where nothing may leave the machine** never does, whatever was asked; neither does one with the network off or `web.search` blocked. The check says why on its card and in the Evidence tab.
- Each search goes through the permission gate on its real query (`web.search`, `web:search/<query>`). If the gate would still have to ask (a critical ask, which a lookup never is), the check carries on without the web, never stalls. At most 8 claims of a check are looked up, only those the sources cover least, with 3 results each. A search that fails costs the check nothing.
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
