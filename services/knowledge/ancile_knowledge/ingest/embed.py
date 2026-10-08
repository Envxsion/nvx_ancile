"""
------------------------------------------------------------------
 Title    |  Embeddings
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  One interface, several embedders:
          |    LocalEmbedder   fastembed on CPU (default; zero keys)
          |    GatewayEmbedder any provider via Core's Gateway
          |    HashEmbedder    deterministic, offline; tests and evals
          |  Chunks are stored per model_key, so changing the embedder
          |  re-embeds in the background while search keeps using the
          |  old index until the new one is complete.
 How      |  get_embedder() loads the configured model once per
          |  process. Ingestion may download weights on first use
          |  (KNOWLEDGE_MODEL_DOWNLOAD); search passes download=False
          |  and never fetches anything at query time. When nothing can
          |  be loaded it raises embed.unavailable, and callers fall
          |  back to text search.
 Note     |  TODO(phase-4): GatewayEmbedder and the background
          |  re-embed job when the embedder changes.
------------------------------------------------------------------
"""

from __future__ import annotations

import hashlib
import itertools
import math
import re
import threading
from typing import Protocol

from ..errors import AncileError
from ..obs import get_logger

log = get_logger("embed")


class Embedder(Protocol):
    model_key: str
    dim: int

    def embed(self, texts: list[str]) -> list[list[float]]: ...


def fastembed_available() -> bool:
    try:
        import fastembed  # noqa: F401
    except ImportError:
        return False
    return True


def unavailable(detail: str) -> AncileError:
    return AncileError(
        "embed.unavailable",
        "The embedding model is unavailable",
        "Retry, or change the embedder in Settings. Text search still works meanwhile.",
        status=503,
        retryable=True,
        error_class="transient",
        detail=detail,
    )


class LocalEmbedder:
    """fastembed (ONNX, CPU). Model weights cache in KNOWLEDGE_MODEL_CACHE."""

    def __init__(self, model_name: str, cache_dir: str, *, local_only: bool = False) -> None:
        from fastembed import TextEmbedding

        self.model_key = f"local/{model_name}"
        self._model = TextEmbedding(model_name=model_name, cache_dir=cache_dir, local_files_only=local_only)
        self.dim = len(next(iter(self._model.embed(["dimension probe"]))))

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [v.tolist() for v in self._model.embed(texts)]

    def embed_query(self, text: str) -> list[float]:
        # bge models want the query instruction; fastembed applies it here.
        vector: list[float] = next(iter(self._model.query_embed(text))).tolist()
        return vector


class HashEmbedder:
    """
    Feature hashing of word unigrams and bigrams into a unit vector. No model,
    no network, fully deterministic: lexical overlap becomes cosine similarity.
    For tests and offline evaluation only, never a production default.
    """

    def __init__(self, dim: int = 256) -> None:
        self.dim = dim
        self.model_key = f"test/hash-{dim}"

    def _vec(self, text: str) -> list[float]:
        words = re.findall(r"\w+", text.lower())
        v = [0.0] * self.dim
        for feat in [*words, *(f"{a} {b}" for a, b in itertools.pairwise(words))]:
            h = int.from_bytes(hashlib.blake2b(feat.encode(), digest_size=8).digest(), "big")
            v[h % self.dim] += 1.0 if (h >> 63) & 1 else -1.0
        norm = math.sqrt(sum(x * x for x in v)) or 1.0
        return [x / norm for x in v]

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._vec(t) for t in texts]


def embed_query(embedder: Embedder, text: str) -> list[float]:
    fn = getattr(embedder, "embed_query", None)
    return fn(text) if fn else embedder.embed([text])[0]


class GatewayEmbedder:
    def __init__(self, model_id: str, dim: int) -> None:
        self.model_key = model_id
        self.dim = dim

    def embed(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError("TODO(phase-4): core_client.embeddings(model_id, texts)")


_lock = threading.Lock()
_loaded: Embedder | None = None
_override: Embedder | None = None
_failed: str | None = None


def set_embedder(embedder: Embedder | None) -> None:
    """Use this embedder for the process (tests, evals). None restores the default."""
    global _override, _loaded, _failed
    with _lock:
        _override = embedder
        _loaded = None
        _failed = None


def get_embedder(*, download: bool = False) -> Embedder:
    """The configured embedder. Raises embed.unavailable when it cannot load."""
    global _loaded, _failed
    if _override is not None:
        return _override
    if _loaded is not None:
        return _loaded
    from ..settings import get_settings

    settings = get_settings()
    with _lock:
        if _loaded is not None:
            return _loaded
        if not fastembed_available():
            raise unavailable("fastembed is not installed (uv sync --extra embed)")
        cache = settings.model_cache
        cache.mkdir(parents=True, exist_ok=True)
        allow = download and settings.model_download
        try:
            _loaded = LocalEmbedder(settings.embed_model, str(cache), local_only=not allow)
            _failed = None
            log.info("embedder loaded", model=_loaded.model_key, dim=_loaded.dim)
            return _loaded
        except Exception as exc:
            _failed = f"{settings.embed_model}: {type(exc).__name__}"
            log.warning("embedder unavailable", model=settings.embed_model, error=type(exc).__name__)
            raise unavailable(_failed) from exc


def try_get_embedder(*, download: bool = False) -> Embedder | None:
    try:
        return get_embedder(download=download)
    except AncileError:
        return None
