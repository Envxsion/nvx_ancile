# NVX Ancile · Knowledge

The grounding layer: ingestion, chunking, embeddings, hybrid search, reranking, evidence for fact-checking, and duplicate and staleness detection. Python 3.12 + FastAPI + uv. Only Core calls it (`/kn/v1`, service token). Every model call it makes goes through Core's Gateway (`core_client.py`), so fallbacks and traces cover it too (DESIGN.md D5).

```bash
uv sync                          # base: API, DB, chunking, search, dedupe
uv sync --extra embed            # local fastembed embedder + reranker (CPU)
uv sync --extra extract          # content-core + MarkItDown
uv sync --extra docling          # layout-heavy PDFs (pulls torch)
uv run alembic upgrade head      # schema "knowledge"
uv run ancile-knowledge          # :7710
uv run pytest                    # all tests
uv run pytest -m boot            # boot suite only
```

| Module | State |
|---|---|
| `ingest/chunk.py`: structure-aware chunking with exact offsets, heading paths, overlap and parent/child | Implemented and tested |
| `search/hybrid.py`: reciprocal rank fusion | Implemented and tested |
| `sources/dedupe.py`: exact hash + MinHash near-duplicates and new versions | Implemented and tested |
| `sources/stale.py`: ETag / Last-Modified / hash staleness | Implemented and tested |
| `resilience.py`: retry with full jitter, deadlines, circuit breaker | Implemented and tested |
| `main.py`, `health.py`, `errors.py`, `obs.py`: app, health checks, error shape, JSON logs with traces | Implemented |
| `db.py` + `alembic/versions/0001_init.py`: the full knowledge schema and the per-model HNSW index helper | Implemented |
| `ingest/extract.py`: engine choice | Implemented. The adapters are `TODO(phase-3)`. |
| `ingest/{enrich,embed,pipeline}.py`, `search/rerank.py`, `jobs.py`, `/kn/v1` handlers | `TODO(phase-3/4)`. The routes answer 501 in the standard error shape. |
