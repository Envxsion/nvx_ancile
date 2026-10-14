# Fact-checking and confidence

Any answer can be checked claim by claim against your sources, and optionally the web, by a second model that didn't write it.

## Using it

- Press `f` on a message, or **Fact-check** in its hover actions.
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
2. **Gather evidence.** Your notebook's sources are searched first (hybrid search, then reranking). If web search is on and permitted, the top results are fetched as untrusted content.
3. **Verify independently.** A verifier model **from a different family** than the one that answered judges each claim against the evidence alone: *supported*, *contradicted* or *insufficient*, with exact quotes. If only one family is available, the check still runs and says so.
4. **Score.**

**When no model is set for a step.** With no provider key (so no model on the utility or `factcheck.verify` chain is ready), the fact-check does not give up at once. It asks, in order: Claude Code's quickest model (`claude-code/haiku`, when Claude Code is installed and verified; one lean call each, with no tools, none of your Claude Code settings and a 90-second limit, so it counts against your Claude plan like any Claude Code use), then the smallest Ollama model you pulled of 14B or less. Only when none of these is there does it stop with `factcheck.no_model`, and the message lists each thing it tried.

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

## Citations during generation

Before a model answers in a notebook, each retrieved excerpt gets a marker, and the model is asked to cite with it (`[^3]`). Ancile then checks every citation: the marker must exist and the quoted text must overlap the excerpt. Invalid citations are removed and counted in the trace, so you never see a link to something that doesn't say what's claimed.

## When sources are removed or change

Every check of an answer is kept. When you check an answer again, the score before is shown beside the new one ("Was 84%"), and if the sources behind that earlier score have since been deleted, merged away or read again with different text, a note says so: "Sources changed since: 1 removed." A drop in score after a source went is explained, not alarming. `GET /messages/:id/factcheck` carries it as `previous`.

Citations hold up the same way. Each citation keeps the passage it quoted, its source's title and a sha256 of the whole passage as the model was given it. If the source is deleted, the chip reads **Source removed** and the quote is still there to read (Core keeps a tombstone with the source's name and date, so this holds even after the knowledge service purges the source). If the source is read again (a page edited, a file replaced) and the passage is no longer there word for word, the chip reads **Source changed since cited**. When the same words simply moved to another passage, nothing is flagged. A citation that cannot be checked (the knowledge service is down) is left as it is, never flagged.

## Limits

- The verifier sees only the evidence found. If your sources don't cover a claim, the best possible result is *unverified*, never *verified*.
- Web evidence is only as good as the pages found, and it's treated as untrusted content.
- The score is a guide to where to look, not a guarantee.
