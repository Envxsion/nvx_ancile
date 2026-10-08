"""
------------------------------------------------------------------
 Title    |  Search: scoped hybrid retrieval
 Ref      |  DESIGN.md §3.2, §10 · contracts SearchRequest/SearchResponse
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  One query → ranked passages with exact spans, drawn only
          |  from what the caller may see: one workspace, optionally
          |  one notebook (honouring each source's context level) and
          |  a source list.
 How      |  1. scope    a CTE of non-deleted sources in the workspace
          |               that have a ready version; with a notebook,
          |               only links at level 'full' give chunks and
          |               'insights' links give their summary instead
          |  2. vector   pgvector cosine over the active model's rows,
          |               ORDER BY embedding::vector(dim) <=> q, the
          |               same cast and model_key predicate as the
          |               per-model HNSW index (db.hnsw_index_sql)
          |  3. text     websearch_to_tsquery('english') split into its
          |               operands; a passage matching any of them is a
          |               candidate, ranked by the BM25 idf of the
          |               operands it contains (rare terms such as a
          |               product code count most), then ts_rank_cd
          |  4. fuse     RRF (hybrid.py), top 50 from each retriever
          |  5. rerank   cross-encoder over the fused head, if cached
          |  Scope is applied in SQL before fusion, so fusion can never
          |  widen it.
 Note     |  Without an embedder, hybrid degrades to text and the
          |  response says mode "text" with embedder null.
------------------------------------------------------------------
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.orm import Session

from .. import offsets
from ..db import sessions
from ..ingest import embed as embed_mod
from ..obs import get_logger
from . import rerank as rerank_mod
from .hybrid import reciprocal_rank_fusion

log = get_logger("search")

S = "knowledge"
Mode = Literal["hybrid", "vector", "text"]
CANDIDATES = 50
RERANK_HEAD = 30

# A ranked candidate: (id, sort key). Lower keys rank first.
Ranked = list[tuple[str, tuple[Any, ...]]]


@dataclass
class Query:
    workspace_id: str
    query: str
    notebook_id: str | None = None
    source_ids: list[str] | None = None
    k: int = 12
    mode: Mode = "hybrid"
    rerank: bool = True


@dataclass
class _Cand:
    kind: str
    id: str
    source_id: str
    source_title: str
    text: str
    heading_path: list[str] = field(default_factory=list)
    page: int | None = None
    char_start: int = 0
    char_end: int = 0
    version: int | None = None


def _scope_sql(q: Query, level: str) -> tuple[str, dict[str, Any]]:
    """Sources the query may draw from at this context level ('full' or 'insights')."""
    params: dict[str, Any] = {"ws": q.workspace_id}
    sql = f"SELECT s.id, s.title, s.current_version FROM {S}.sources s"
    if q.notebook_id is not None:
        sql += (
            f" JOIN {S}.notebook_sources ns ON ns.source_id = s.id"
            f" AND ns.notebook_id = :nb AND ns.context_level = :level"
        )
        params["nb"] = q.notebook_id
        params["level"] = level
    elif level != "full":
        return "", params  # insight hits exist only inside a notebook
    sql += " WHERE s.workspace_id = :ws AND s.deleted_at IS NULL AND s.current_version > 0"
    if q.source_ids is not None:
        sql += " AND s.id = ANY(:ids)"
        params["ids"] = q.source_ids
    return sql, params


def split_tsquery(tsq: str) -> list[str]:
    """Top-level operands of a tsquery's text form: "'a' & 'b' <-> 'c'" -> ["'a'", "'b' <-> 'c'"]."""
    parts: list[str] = []
    buf: list[str] = []
    depth = 0
    in_quote = False
    i = 0
    while i < len(tsq):
        ch = tsq[i]
        if ch == "'":
            if in_quote and i + 1 < len(tsq) and tsq[i + 1] == "'":
                buf.append("''")
                i += 2
                continue
            in_quote = not in_quote
        elif not in_quote and ch == "(":
            depth += 1
        elif not in_quote and ch == ")":
            depth -= 1
        elif not in_quote and depth == 0 and ch in "&|" and tsq[i - 1 : i] == " ":
            parts.append("".join(buf).strip())
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    if "".join(buf).strip():
        parts.append("".join(buf).strip())
    return list(dict.fromkeys(p for p in parts if p))


@dataclass
class _Terms:
    """The query as weighted tsquery operands, for IDF-weighted term coverage."""

    any: str  # every operand OR-ed: what a row must match to be a candidate
    terms: list[str]
    idf: list[float]


def _terms(db: Session, workspace_id: str, query: str) -> _Terms | None:
    """
    Postgres ts_rank has no inverse document frequency, so a rare product code
    weighs no more than "pump". Weight each operand by BM25's idf over the
    workspace's searchable passages instead, and rank by the weights matched.
    A query with a negation keeps websearch's AND semantics as one operand.
    """
    tsq = str(
        db.execute(text("SELECT websearch_to_tsquery('english', :q)::text"), {"q": query}).scalar() or ""
    )
    if not tsq.strip():
        return None  # only stopwords
    terms = [tsq] if "!" in tsq else split_tsquery(tsq)
    rows = db.execute(
        text(
            f"WITH live AS (SELECT c.tsv FROM {S}.chunks c JOIN {S}.sources s ON s.id = c.source_id "
            f"  AND c.version = s.current_version WHERE s.workspace_id = :ws AND s.deleted_at IS NULL "
            f"  AND c.parent_id IS NOT NULL) "
            f"SELECT u.ord, (SELECT count(*) FROM live WHERE live.tsv @@ CAST(u.t AS tsquery)) AS n, "
            f"  (SELECT count(*) FROM live) AS total "
            f"FROM unnest(CAST(:terms AS text[])) WITH ORDINALITY AS u(t, ord) ORDER BY u.ord"
        ),
        {"ws": workspace_id, "terms": terms},
    ).all()
    idf = [math.log(1 + (int(total) - int(n) + 0.5) / (int(n) + 0.5)) for _, n, total in rows]
    return _Terms(" | ".join(f"({t})" for t in terms), terms, idf)


_WEIGHTS = (
    "w AS (SELECT CAST(u.t AS tsquery) AS tq, u.idf "
    "FROM unnest(CAST(:terms AS text[]), CAST(:idf AS float8[])) AS u(t, idf))"
)


def _text_chunks(db: Session, terms: _Terms, scope: str, params: dict[str, Any]) -> Ranked:
    rows = db.execute(
        text(
            f"WITH scope AS ({scope}), {_WEIGHTS}, "
            f"cand AS (SELECT c.id, c.tsv FROM {S}.chunks c JOIN scope ON scope.id = c.source_id "
            f"  AND c.version = scope.current_version "
            f"  WHERE c.parent_id IS NOT NULL AND c.tsv @@ CAST(:any AS tsquery)) "
            f"SELECT cand.id, sum(w.idf) AS score, ts_rank_cd(cand.tsv, CAST(:any AS tsquery), 1) AS r "
            f"FROM cand JOIN w ON cand.tsv @@ w.tq GROUP BY cand.id, cand.tsv "
            f"ORDER BY score DESC, r DESC, cand.id LIMIT :n"
        ),
        {**params, "terms": terms.terms, "idf": terms.idf, "any": terms.any, "n": CANDIDATES},
    ).all()
    return [(r[0], (-float(r[1]), -float(r[2]))) for r in rows]


_iterative: bool | None = None


def _has_iterative(db: Session) -> bool:
    global _iterative
    if _iterative is None:
        v = db.execute(text("SELECT extversion FROM pg_extension WHERE extname = 'vector'")).scalar() or "0"
        parts = [int(p) for p in str(v).split(".")[:2] if p.isdigit()]
        _iterative = tuple(parts) >= (0, 8)
    return _iterative


def _vec(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.7g}" for x in v) + "]"


def _vector_chunks(
    db: Session, scope: str, params: dict[str, Any], model_key: str, vec: list[float]
) -> Ranked:
    dim = len(vec)
    if _has_iterative(db):
        # pgvector >= 0.8: keep scanning the HNSW index until enough rows pass the scope filter.
        db.execute(text("SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)"))
    rows = db.execute(
        text(
            f"WITH scope AS ({scope}) "
            f"SELECT e.chunk_id, e.embedding::vector({dim}) <=> CAST(:qv AS vector({dim})) AS d "
            f"FROM {S}.chunk_embeddings e "
            f"JOIN {S}.chunks c ON c.id = e.chunk_id AND c.parent_id IS NOT NULL "
            f"JOIN scope ON scope.id = c.source_id AND c.version = scope.current_version "
            f"WHERE e.model_key = :mk "
            f"ORDER BY e.embedding::vector({dim}) <=> CAST(:qv AS vector({dim})), e.chunk_id LIMIT :n"
        ),
        {**params, "mk": model_key, "qv": _vec(vec), "n": CANDIDATES},
    ).all()
    return [(r[0], (float(r[1]),)) for r in rows]


def _insight_candidates(
    db: Session, scope: str, params: dict[str, Any], terms: _Terms | None
) -> tuple[list[_Cand], Ranked]:
    """Summaries of 'insights'-level sources, ranked on the same scale as passages."""
    rows = (
        db.execute(
            text(
                f"WITH scope AS ({scope}) SELECT i.id, i.source_id, scope.title, i.content_md "
                f"FROM {S}.insights i JOIN scope ON scope.id = i.source_id "
                f"WHERE i.transformation_id = 'summary' ORDER BY i.id"
            ),
            params,
        )
        .mappings()
        .all()
    )
    cands = [_Cand("insight", r["id"], r["source_id"], r["title"], r["content_md"]) for r in rows]
    if not cands or terms is None:
        return cands, []
    doc = "to_tsvector('english', s.title || ' ' || i.content_md)"
    ranked_rows = db.execute(
        text(
            f"WITH {_WEIGHTS} SELECT i.id, sum(w.idf) AS score, "
            f"ts_rank_cd({doc}, CAST(:any AS tsquery), 1) AS r "
            f"FROM {S}.insights i JOIN {S}.sources s ON s.id = i.source_id JOIN w ON {doc} @@ w.tq "
            f"WHERE i.id = ANY(:ids) GROUP BY i.id, s.title, i.content_md"
        ),
        {"terms": terms.terms, "idf": terms.idf, "any": terms.any, "ids": [c.id for c in cands]},
    ).all()
    return cands, [(r[0], (-float(r[1]), -float(r[2]))) for r in ranked_rows]


def _load_chunks(db: Session, ids: list[str]) -> dict[str, _Cand]:
    if not ids:
        return {}
    rows = db.execute(
        text(
            f"SELECT c.id, c.source_id, s.title, c.text, c.heading_path, c.page, c.char_start, c.char_end, "
            f"c.version FROM {S}.chunks c JOIN {S}.sources s ON s.id = c.source_id WHERE c.id = ANY(:ids)"
        ),
        {"ids": ids},
    ).mappings()
    return {
        r["id"]: _Cand(
            "chunk",
            r["id"],
            r["source_id"],
            r["title"],
            r["text"],
            list(r["heading_path"] or []),
            r["page"],
            r["char_start"],
            r["char_end"],
            r["version"],
        )
        for r in rows
    }


def _cos(a: list[float], b: list[float]) -> float:
    na = sum(x * x for x in a) ** 0.5 or 1.0
    nb = sum(x * x for x in b) ** 0.5 or 1.0
    return sum(x * y for x, y in zip(a, b, strict=True)) / na / nb


def search(q: Query) -> dict[str, Any]:
    started = time.perf_counter()
    mode: Mode = q.mode
    embedder = None
    qvec: list[float] | None = None
    if mode in ("hybrid", "vector"):
        embedder = embed_mod.try_get_embedder(download=False)
        if embedder is None:
            mode = "text"  # degrade, and say so in the response
        else:
            qvec = embed_mod.embed_query(embedder, q.query)

    full_scope, full_params = _scope_sql(q, "full")
    ins_scope, ins_params = _scope_sql(q, "insights")
    ranked: dict[str, Ranked] = {}
    cands: dict[str, _Cand] = {}
    insights: list[_Cand] = []
    ins_text: Ranked = []
    with sessions().begin() as db:
        terms = _terms(db, q.workspace_id, q.query) if mode in ("hybrid", "text") else None
        if ins_scope:
            insights, ins_text = _insight_candidates(db, ins_scope, ins_params, terms)
            cands.update({c.id: c for c in insights})
        if mode in ("hybrid", "text"):
            ranked["text"] = _text_chunks(db, terms, full_scope, full_params) if terms else []
        if mode in ("hybrid", "vector") and embedder is not None and qvec is not None:
            ranked["vector"] = _vector_chunks(db, full_scope, full_params, embedder.model_key, qvec)
        cands.update(_load_chunks(db, sorted({i for r in ranked.values() for i, _ in r})))

    # Insight hits join the same rankings by the same measure (ts_rank_cd, cosine
    # distance), so they compete fairly and the "why" view explains them too.
    if insights:
        if "text" in ranked:
            ranked["text"] = ranked["text"] + ins_text
        if "vector" in ranked and embedder is not None and qvec is not None:
            ivecs = embedder.embed([f"{c.source_title}\n\n{c.text}" for c in insights])
            ranked["vector"] = ranked["vector"] + [
                (c.id, (1 - _cos(qvec, v),)) for c, v in zip(insights, ivecs, strict=True)
            ]
    rankings = {
        name: [i for i, _ in sorted(rows, key=lambda t: (t[1], t[0]))][:CANDIDATES]
        for name, rows in ranked.items()
    }

    fused = reciprocal_rank_fusion(rankings, limit=max(q.k, RERANK_HEAD))
    order = [f.id for f in fused]
    rerank_scores: dict[str, float] = {}
    reranker = rerank_mod.get_reranker() if q.rerank else None
    if reranker is not None and not isinstance(reranker, rerank_mod.IdentityReranker) and order:
        try:
            scored = reranker.rerank(q.query, [(i, cands[i].text) for i in order[:RERANK_HEAD]])
            rerank_scores = {s.id: s.score for s in scored}
            order = [s.id for s in scored] + [i for i in order if i not in rerank_scores]
        except Exception as exc:  # never fail a search on rerank
            log.warning("rerank failed", error=type(exc).__name__)
            rerank_scores = {}

    by_id = {f.id: f for f in fused}
    hits = []
    for doc_id in order[: q.k]:
        c = cands[doc_id]
        f = by_id[doc_id]
        # Offsets leave in UTF-16 units, the way the Cockpit slices text.
        u16 = offsets.for_version(c.source_id, c.version) if c.kind == "chunk" else (lambda i: i)
        hits.append(
            {
                "kind": c.kind,
                "chunk_id": c.id,
                "source_id": c.source_id,
                "source_title": c.source_title,
                "text": c.text,
                "heading_path": c.heading_path,
                "page": c.page,
                "char_start": u16(c.char_start),
                "char_end": u16(c.char_end),
                "score": round(f.score, 6),
                "rerank_score": round(rerank_scores[doc_id], 6) if doc_id in rerank_scores else None,
                "ranks": {"vector": f.ranks.get("vector"), "text": f.ranks.get("text")},
            }
        )
    return {
        "hits": hits,
        "mode": mode,
        "embedder": embedder.model_key if embedder is not None and mode != "text" else None,
        "ms": round((time.perf_counter() - started) * 1000, 1),
    }
