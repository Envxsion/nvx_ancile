"""
------------------------------------------------------------------
 Title    |  Retrieval eval: vector-only vs hybrid
 Ref      |  ROADMAP.md Phase 3 · tests/eval/README.md
 ID       |  eval
------------------------------------------------------------------
 Purpose  |  Measure what hybrid search buys over vector search on a
          |  fixed corpus, so a regression shows up as a number.
 How      |  Ingests corpus.py (written documents and generated
          |  look-alike families) through the real pipeline into a
          |  throwaway workspace of the test database, runs every case
          |  in cases.jsonl in each mode, and reports document-level
          |  recall@5, recall@10, MRR and nDCG@10 (a hit's document is
          |  its source; the top 50 passages are collapsed to ranked
          |  documents). The workspace is deleted afterwards.
          |
          |    uv run --directory services/knowledge python ../../tests/eval/retrieval/run.py
          |
          |  Database: ANCILE_TEST_DATABASE_URL, else DATABASE_URL with
          |  the database renamed to ancile_kn_test (as the pytest suite
          |  does). Embedder: the configured fastembed model if its
          |  weights are cached; --download fetches them once into the
          |  model cache; --embedder hash uses the offline hash
          |  embedder (a smoke test, not a quality measurement).
 Note     |  Exit code 1 when hybrid fails the roadmap gate: recall@10
          |  at least 10% better than vector-only, relative or absolute.
          |  Relevance is per document, not per span; TODO(phase-4):
          |  span-level judgements as tests/eval/README.md describes.
------------------------------------------------------------------
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import shutil
import sys
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def _db_url() -> str:
    explicit = os.environ.get("ANCILE_TEST_DATABASE_URL")
    if explicit:
        return explicit
    base = os.environ.get("DATABASE_URL")
    if not base:
        sys.exit(
            "Set ANCILE_TEST_DATABASE_URL (or DATABASE_URL) to a Postgres with pgvector "
            "and the knowledge schema."
        )
    p = urlsplit(base)
    return urlunsplit((p.scheme, p.netloc, "/ancile_kn_test", p.query, p.fragment))


def parse() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--embedder", choices=["local", "hash"], default="local")
    ap.add_argument("--download", action="store_true", help="allow downloading the embedder weights once")
    ap.add_argument("--json", action="store_true", help="print the metrics as JSON")
    ap.add_argument("--show-misses", action="store_true", help="list cases whose documents miss the top 10")
    return ap.parse_args()


def metrics(ranked: list[str], relevant: set[str]) -> dict[str, float]:
    def recall(k: int) -> float:
        return len(relevant & set(ranked[:k])) / len(relevant)

    rr = next((1 / (i + 1) for i, d in enumerate(ranked) if d in relevant), 0.0)
    dcg = sum(1 / math.log2(i + 2) for i, d in enumerate(ranked[:10]) if d in relevant)
    idcg = sum(1 / math.log2(i + 2) for i in range(min(len(relevant), 10)))
    return {"recall@5": recall(5), "recall@10": recall(10), "mrr": rr, "ndcg@10": dcg / idcg}


def main() -> int:
    args = parse()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    os.environ["DATABASE_URL"] = _db_url()
    os.environ["KNOWLEDGE_WORKER"] = "false"
    os.environ["KNOWLEDGE_MODEL_DOWNLOAD"] = "true" if args.download else "false"
    os.environ.setdefault("ANCILE_LOG_LEVEL", "warning")
    data_dir = Path(tempfile.mkdtemp(prefix="ancile-eval-"))
    os.environ["KNOWLEDGE_DATA_DIR"] = str(data_dir)

    from corpus import DOCS, family_cases
    from sqlalchemy import text

    from ancile_knowledge import jobs
    from ancile_knowledge.db import sessions
    from ancile_knowledge.ingest import embed
    from ancile_knowledge.obs import configure_logging
    from ancile_knowledge.search import rerank
    from ancile_knowledge.search.service import Query, search
    from ancile_knowledge.sources import repo

    configure_logging("warning")
    if args.embedder == "hash":
        embed.set_embedder(embed.HashEmbedder())
    try:
        embedder = embed.get_embedder(download=args.download)
    except Exception as exc:
        print(
            f"The embedder could not load ({exc}). Re-run with --download to fetch it once, "
            "or --embedder hash for an offline smoke test.",
            file=sys.stderr,
        )
        return 2
    reranker = rerank.get_reranker()
    has_reranker = not isinstance(reranker, rerank.IdentityReranker)

    lines = (HERE / "cases.jsonl").read_text(encoding="utf-8").splitlines()
    cases = [json.loads(line) for line in lines if line] + family_cases()
    ws = f"eval-{uuid.uuid4().hex[:8]}"
    id_of: dict[str, str] = {}
    try:
        with sessions().begin() as db:
            for d in DOCS:
                sid = repo.new_id()
                id_of[sid] = d["id"]
                repo.write_atomic(repo.input_path(sid), d["text"].strip() + "\n")
                db.execute(
                    text(
                        "INSERT INTO knowledge.sources "
                        "(id, workspace_id, kind, title, status, progress, tags, "
                        "topics) VALUES (:id, :ws, 'text', :t, 'queued', '{}', '{}', '{}')"
                    ),
                    {"id": sid, "ws": ws, "t": d["title"]},
                )
        asyncio.run(jobs.drain())
        with sessions().begin() as db:
            not_ready = db.execute(
                text("SELECT count(*) FROM knowledge.sources WHERE workspace_id = :ws AND status <> 'ready'"),
                {"ws": ws},
            ).scalar_one()
        if not_ready:
            print(
                f"{not_ready} documents did not reach ready; results would be meaningless.", file=sys.stderr
            )
            return 2

        modes: list[tuple[str, str, bool]] = [("vector", "vector", False), ("text", "text", False),
                                               ("hybrid", "hybrid", False)]  # fmt: skip
        if has_reranker:
            modes.append(("hybrid+rerank", "hybrid", True))
        results: dict[str, dict[str, dict[str, float]]] = {}
        for label, mode, use_rerank in modes:
            per_type: dict[str, list[dict[str, float]]] = {}
            for case in cases:
                res = search(Query(workspace_id=ws, query=case["query"], k=50, mode=mode, rerank=use_rerank))  # type: ignore[arg-type]
                assert res["mode"] == mode, f"search degraded to {res['mode']}"
                docs = list(dict.fromkeys(id_of[h["source_id"]] for h in res["hits"]))
                m = metrics(docs, set(case["relevant"]))
                if args.show_misses and m["recall@10"] < 1:
                    print(f"[{label}] miss: {case['query']!r} want {case['relevant']} got {docs[:5]}")
                per_type.setdefault("all", []).append(m)
                per_type.setdefault(case.get("type", "other"), []).append(m)
            results[label] = {
                t: {k: sum(m[k] for m in ms) / len(ms) for k in ms[0]} for t, ms in per_type.items()
            }
    finally:
        with sessions().begin() as db:
            db.execute(text("DELETE FROM knowledge.sources WHERE workspace_id = :ws"), {"ws": ws})
        shutil.rmtree(data_dir, ignore_errors=True)

    vec = results["vector"]["all"]["recall@10"]
    hyb = results["hybrid"]["all"]["recall@10"]
    absolute = hyb - vec
    relative = (hyb / vec - 1) if vec else math.inf
    passed = absolute >= 0.10 or relative >= 0.10
    summary = {
        "embedder": embedder.model_key,
        "reranker": reranker.model_key,
        "documents": len(DOCS),
        "cases": len(cases),
        "results": results,
        "gate": {"absolute": round(absolute, 4), "relative": round(relative, 4), "passed": passed},
    }
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(f"Embedder {embedder.model_key} · reranker {reranker.model_key} · {len(DOCS)} documents · "
              f"{len(cases)} cases")  # fmt: skip
        header = f"{'mode':<15}{'subset':<10}{'recall@5':>10}{'recall@10':>11}{'MRR':>8}{'nDCG@10':>9}"
        print(header)
        for label, by_type in results.items():
            for t in ("all", "keyword", "semantic", "family"):
                if t in by_type:
                    m = by_type[t]
                    print(f"{label:<15}{t:<10}{m['recall@5']:>10.3f}{m['recall@10']:>11.3f}{m['mrr']:>8.3f}"
                          f"{m['ndcg@10']:>9.3f}")  # fmt: skip
        print(
            f"Hybrid vs vector recall@10: {hyb:.3f} vs {vec:.3f} "
            f"(+{absolute:.3f} absolute, {relative * 100:+.1f}% relative) · "
            f"gate {'passed' if passed else 'FAILED'}"
        )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
