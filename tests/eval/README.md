# Evals

Quality is measured, not asserted. These suites run nightly in CI (`.github/workflows/nightly.yml`) and fail the run when a metric drops below its threshold.

## retrieval/ (Phase 3)

- **Corpus:** `corpus/`, a fixed set of documents with mixed formats: a long PDF with tables, a scanned page, HTML and markdown.
- **Cases:** `cases.jsonl`, one object per line: `{ "query": "...", "relevant_chunks": ["<source>#<char_start>-<char_end>", ...] }`.
- **Runner:** `run.py`. It ingests the corpus into a throwaway schema, then runs each query in three modes: vector only, hybrid, and hybrid + rerank.
- **Reports:** recall@5, recall@10, MRR and nDCG@10.
- **Thresholds:**
  - Hybrid + rerank recall@10 is at least 0.85.
  - Hybrid beats vector-only by at least 10% recall@10 (ROADMAP Phase 3).

## factcheck/ (Phase 4)

- **Cases:** `cases.jsonl`, with labelled claims against fixed evidence: supported, contradicted, insufficient, including near-miss numbers and dates.
- **Runner:** `run.py`.
- **Reports:**
  - Verdict accuracy and macro-F1.
  - Calibration of the confidence score (expected calibration error).
- **Thresholds:**
  - Macro-F1 is at least 0.75.
  - ECE is at most 0.12.

TODO(phase-3): add the corpus, cases and runner for retrieval.
TODO(phase-6): add the labelled cases and the runner for factcheck, and gate CI on it (v0.2 plan).
