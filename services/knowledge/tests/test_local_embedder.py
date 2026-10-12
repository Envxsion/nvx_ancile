"""
One-click embedder download (Core's Admin → Models → Download a local model):
Knowledge says whether a fastembed model is cached, and fetches it with
fastembed's own downloader. fastembed itself is replaced by a fake here, so
nothing is downloaded.
"""

from __future__ import annotations

from typing import Any, ClassVar

import pytest
from fastapi.testclient import TestClient

from ancile_knowledge.ingest import embed
from ancile_knowledge.main import create_app
from ancile_knowledge.settings import get_settings

AUTH = {"authorization": "Bearer test-service-token"}


class FakeLocal:
    cached: ClassVar[set[str]] = set()
    calls: ClassVar[list[tuple[str, bool]]] = []

    def __init__(self, model_name: str, cache_dir: str, *, local_only: bool = False) -> None:
        FakeLocal.calls.append((model_name, local_only))
        if local_only and model_name not in FakeLocal.cached:
            raise ValueError("not in the cache")
        if model_name == "broken/model":
            raise OSError("network")
        FakeLocal.cached.add(model_name)
        self.model_key = f"local/{model_name}"
        self.dim = 384

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[0.0] * self.dim for _ in texts]


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> Any:
    FakeLocal.cached = set()
    FakeLocal.calls = []
    monkeypatch.setattr(embed, "fastembed_available", lambda: True)
    monkeypatch.setattr(embed, "LocalEmbedder", FakeLocal)
    monkeypatch.setattr(embed, "_installed", set())
    monkeypatch.setenv("KNOWLEDGE_MODEL_CACHE", str(tmp_path))
    monkeypatch.setenv("KNOWLEDGE_MODEL_DOWNLOAD", "true")
    get_settings.cache_clear()
    yield TestClient(create_app(), raise_server_exceptions=False)
    monkeypatch.undo()
    get_settings.cache_clear()
    embed.set_embedder(None)


def test_status_never_downloads_and_prepare_fetches_once(client: TestClient) -> None:
    r = client.get("/kn/v1/embeddings/local", params={"model": "BAAI/bge-small-en-v1.5"}, headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"model": "BAAI/bge-small-en-v1.5", "installed": False, "downloadable": True}
    assert FakeLocal.calls == [("BAAI/bge-small-en-v1.5", True)]

    r = client.post("/kn/v1/embeddings/prepare", json={"model": "BAAI/bge-small-en-v1.5"}, headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"model_key": "local/BAAI/bge-small-en-v1.5", "dim": 384}
    assert FakeLocal.calls[-1] == ("BAAI/bge-small-en-v1.5", False)

    r = client.get("/kn/v1/embeddings/local", params={"model": "BAAI/bge-small-en-v1.5"}, headers=AUTH)
    assert r.json()["installed"] is True


def test_a_failed_download_is_an_error_in_the_standard_shape(client: TestClient) -> None:
    r = client.post("/kn/v1/embeddings/prepare", json={"model": "broken/model"}, headers=AUTH)
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "embed.unavailable"


def test_names_are_checked_and_downloads_can_be_switched_off(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    r = client.post("/kn/v1/embeddings/prepare", json={"model": "../../etc"}, headers=AUTH)
    assert r.status_code == 422
    monkeypatch.setenv("KNOWLEDGE_MODEL_DOWNLOAD", "false")
    get_settings.cache_clear()
    r = client.post("/kn/v1/embeddings/prepare", json={"model": "BAAI/bge-small-en-v1.5"}, headers=AUTH)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "embed.download_off"
    assert client.get("/kn/v1/embeddings/local", params={"model": "x"}).status_code == 401
