"""
------------------------------------------------------------------
 Title    |  Hybrid search: reciprocal rank fusion
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Fuse full-text (tsvector) and vector (pgvector HNSW)
          |  rankings into one list, then hand the top of it to the
          |  reranker. RRF needs no score calibration between the two
          |  retrievers, which is why it is the default.
 How      |  score(d) = Σ_r  w_r / (k + rank_r(d)),  rank from 1.
          |  Ties break by best single rank, then by id, so results are
          |  deterministic. Scoping (notebook, source) is applied in
          |  SQL before fusion: fusion can never widen scope.
 Note     |  TODO(phase-3): search() issuing both queries in parallel
          |  with the per-model HNSW cast (db.hnsw_index_sql).
------------------------------------------------------------------
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

DEFAULT_K = 60


@dataclass(frozen=True)
class Fused:
    id: str
    score: float
    ranks: dict[str, int] = field(default_factory=dict)  # retriever name → 1-based rank

    @property
    def best_rank(self) -> int:
        return min(self.ranks.values())


def reciprocal_rank_fusion(
    rankings: Mapping[str, Sequence[str]],
    *,
    k: int = DEFAULT_K,
    weights: Mapping[str, float] | None = None,
    limit: int | None = None,
) -> list[Fused]:
    """
    rankings: retriever name → ids, best first. Duplicate ids within one
    ranking count once, at their best position.
    """
    if k < 1:
        raise ValueError("k must be >= 1")
    scores: dict[str, float] = {}
    ranks: dict[str, dict[str, int]] = {}
    for name, ids in rankings.items():
        w = 1.0 if weights is None else weights.get(name, 1.0)
        if w < 0:
            raise ValueError(f"weight for {name} must be non-negative")
        seen: set[str] = set()
        rank = 0
        for doc_id in ids:
            if doc_id in seen:
                continue
            seen.add(doc_id)
            rank += 1
            scores[doc_id] = scores.get(doc_id, 0.0) + w / (k + rank)
            ranks.setdefault(doc_id, {})[name] = rank
    fused = [Fused(doc_id, s, ranks[doc_id]) for doc_id, s in scores.items()]
    fused.sort(key=lambda f: (-f.score, f.best_rank, f.id))
    return fused[:limit] if limit is not None else fused
