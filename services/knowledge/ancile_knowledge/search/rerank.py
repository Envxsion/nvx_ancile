"""
------------------------------------------------------------------
 Title    |  Reranking
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  A cross-encoder rescoring of the fused top-N, the single
          |  biggest quality step after hybrid retrieval.
 How      |  LocalReranker: a fastembed cross-encoder (ONNX, CPU;
          |  KNOWLEDGE_RERANK_MODEL, ms-marco-MiniLM-L-6-v2 by default).
          |  A GPU node or provider reranker can stand in through the
          |  same protocol. Scores are normalised to [0,1] because the
          |  fact-check confidence formula consumes them (DESIGN.md §10).
          |  The weights are loaded from the local cache only: a search
          |  never downloads. Without them, IdentityReranker keeps the
          |  fused order, and any rerank error falls back to it too.
 Note     |  TODO(phase-4): fetch reranker weights in the background
          |  after first boot; a timeout around rerank().
------------------------------------------------------------------
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Scored:
    id: str
    score: float  # normalised 0..1


class Reranker(Protocol):
    model_key: str

    def rerank(self, query: str, docs: list[tuple[str, str]]) -> list[Scored]: ...


def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


class IdentityReranker:
    """Keeps fused order. Used when no reranker is configured, and as the
    fallback when the reranker times out."""

    model_key = "identity"

    def rerank(self, query: str, docs: list[tuple[str, str]]) -> list[Scored]:
        n = len(docs)
        return [Scored(doc_id, 1.0 - i / max(n, 1)) for i, (doc_id, _) in enumerate(docs)]


class LocalReranker:
    def __init__(self, model_name: str, cache_dir: str) -> None:
        from fastembed.rerank.cross_encoder import TextCrossEncoder

        self.model_key = f"local/{model_name}"
        self._model = TextCrossEncoder(model_name=model_name, cache_dir=cache_dir, local_files_only=True)

    def rerank(self, query: str, docs: list[tuple[str, str]]) -> list[Scored]:
        if not docs:
            return []
        scores = list(self._model.rerank(query, [text for _, text in docs], batch_size=32))
        out = [Scored(doc_id, sigmoid(float(s))) for (doc_id, _), s in zip(docs, scores, strict=True)]
        return sorted(out, key=lambda s: -s.score)


_reranker: Reranker | None = None
_tried = False
_override: Reranker | None = None


def set_reranker(r: Reranker | None) -> None:
    """Tests and evals: force a reranker (None restores the default)."""
    global _override, _reranker, _tried
    _override, _reranker, _tried = r, None, False


def get_reranker() -> Reranker:
    """The local cross-encoder if its weights are cached, else IdentityReranker."""
    global _reranker, _tried
    if _override is not None:
        return _override
    if _reranker is not None:
        return _reranker
    if not _tried:
        _tried = True
        try:
            from ..settings import get_settings

            s = get_settings()
            _reranker = LocalReranker(s.rerank_model, str(s.model_cache))
        except Exception:
            _reranker = None
    return _reranker or IdentityReranker()
