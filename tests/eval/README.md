# Evals

Quality is measured, not asserted. Both suites run on every push in CI (`.github/workflows/ci.yml`, job "Retrieval and fact-check evals") and **block the build** when a number drops below its floor. In CI they are offline and deterministic: the hash embedder and the offline test models, no provider keys and no network beyond the job's own Postgres. The nightly run (`nightly.yml`) repeats retrieval with the real local embedder.

Floors live next to each suite in `thresholds.json`. Raise a floor when the numbers rise; never lower one without saying why in the commit.

## retrieval/ (Phase 3)

- **Corpus:** `corpus.py`, short original documents with deliberate look-alike families (two pump models, two quarters of results), so a query naming a product code, a form number or a person tests whether hybrid search recovers the exact one.
- **Cases:** `cases.jsonl`, one object per line: `{ "query": "...", "relevant": ["<document id>", ...], "type": "keyword" | "semantic" }`, plus generated `family` cases.
- **Runner:** `run.py`. It ingests the corpus through the real pipeline into a throwaway workspace of the test database (`ancile_kn_test`; `--prepare` creates and migrates it), then runs each query in each mode: vector only, text only, hybrid, and hybrid + rerank when a reranker is installed.
- **Citations:** the same run ingests `factcheck/sources.json` into a second workspace and asks Knowledge's `/evidence` for every fact-check claim that cites a source: is that source in the top 4, ranked first, and is the labelled sentence the quote?
- **Reports:** recall@5, recall@10, MRR and nDCG@10 per mode and subset; citation source@4, source@1 and quote accuracy. `--report <file>` writes them as JSON.
- **Floors** (`retrieval/thresholds.json`, per embedder):
  - Always: hybrid beats vector-only by at least 10% recall@10 (ROADMAP Phase 3).
  - `test/hash-256` (CI): hybrid recall@10 ≥ 0.97, recall@5 ≥ 0.94, MRR ≥ 0.88, nDCG@10 ≥ 0.90; vector recall@10 ≥ 0.67; citations source@4 = 1.0, source@1 and quote ≥ 0.97.
  - The local model (nightly): hybrid recall@10 ≥ 0.85.

```sh
uv run --project services/knowledge python tests/eval/retrieval/run.py --embedder hash --prepare
```

## factcheck/ (Phase 4)

- **Sources:** `sources.json`, six short original documents, one passage per paragraph.
- **Cases:** `cases.jsonl`, 40 labelled claims: supported, contradicted and insufficient, including differing numbers and dates, negations, near-miss words ("July" for "June") and claims nothing covers. Each cited claim names its source and the sentence a correct citation quotes.
- **Runner:** `services/core` `eval:factcheck` (`src/factcheck/evals.ts`). Evidence for each claim is the top passages by BM25 (a deterministic stand-in for Knowledge, whose own half the retrieval run measures), then the real verifier step (prompt, untrusted wrapper, gateway, JSON parsing) on the offline verifier, then the real score.
- **Reports:** verdict accuracy and macro-F1 over verified / contradicted / unverified, per class and per case type; citation accuracy (the evidence the verdict rests on is the labelled sentence of the labelled source); expected calibration error of the confidence against "the claim is true" (5 bins).
- **Floors** (`factcheck/thresholds.json`, offline): accuracy ≥ 0.90, macro-F1 ≥ 0.89, citation accuracy = 1.0, ECE ≤ 0.12. The offline verifier is word overlap, not understanding: it misses near-miss words and a negation elsewhere in the sentence, and the floors say so.

```sh
pnpm --filter @nvx/ancile-core eval:factcheck --show-misses
```

The unit suite also runs the fact-check eval (`services/core/test/factcheck/evals.test.ts`), so a regression fails there first.

TODO(phase-6): the fact-check eval against a real verifier model, nightly, with its own floors (macro-F1 ≥ 0.75, ECE ≤ 0.12).
