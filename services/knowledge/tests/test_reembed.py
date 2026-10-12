"""
Background re-embed (ingest/reembed.py): a changed embedding model is filled
in batches while search keeps reading the old model's vectors, progress is
counted from the database (so a restart resumes), new sources get both
models meanwhile, and the swap is one step that also removes the old vectors.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from ancile_knowledge.db import sessions
from ancile_knowledge.ingest import embed, reembed
from ancile_knowledge.main import create_app
from ancile_knowledge.search.service import Query, search
from tests.conftest import AUTH, add_text_source, drain

pytestmark = pytest.mark.usefixtures("kdb")

OLD, NEW = "test/hash-256", "test/hash-64"

DOCS = {
    "Pump manual": "# Pump manual\n\nThe ZX-4410 pump must be primed before first use. "
    "Open valve V2 and fill the housing.\n\n## Faults\n\nError code E-17 means the impeller is blocked.",
    "Owls": "# Owls\n\nOwls are nocturnal birds of prey. They hunt small mammals at night "
    "and swallow their prey whole.",
    "Sourdough": "# Sourdough\n\nA sourdough starter is a culture of wild yeast. Feed it flour and "
    "water daily and keep it warm.",
}


def _vectors(model_key: str) -> int:
    with sessions().begin() as db:
        return int(
            db.execute(
                text("SELECT count(*) FROM knowledge.chunk_embeddings WHERE model_key = :mk"),
                {"mk": model_key},
            ).scalar_one()
        )


def _vector_search(query: str) -> dict[str, object]:
    return search(Query(workspace_id="ws", query=query, k=5, mode="vector"))


def _ingest_with_old_model() -> dict[str, str]:
    ids = {title: add_text_source("ws", title, body) for title, body in DOCS.items()}
    drain()
    st = reembed.check(download=False)
    assert st["active_model_key"] == OLD and st["reembed"]["status"] == "idle"
    return ids


def test_changing_the_model_reembeds_in_batches_while_search_keeps_the_old_vectors() -> None:
    ids = _ingest_with_old_model()
    old_count = _vectors(OLD)
    assert old_count > 0

    embed.set_embedder(embed.HashEmbedder(64))
    st = reembed.check(download=False)
    job = st["reembed"]
    assert st["active_model_key"] == OLD and st["configured_model_key"] == NEW
    assert job["status"] == "running" and job["target_model_key"] == NEW
    assert job["total"] == old_count and job["done"] == 0 and job["percent"] == 0

    # One batch: progress moves, search still reads the old model and still finds things.
    assert reembed.step(batch=1) is True
    job = reembed.status()["reembed"]
    assert job["done"] == 1 and job["status"] == "running"
    res = _vector_search("impeller blocked")
    assert res["embedder"] == OLD and res["mode"] == "vector"
    assert res["hits"][0]["source_id"] == ids["Pump manual"]

    # A "restart": nothing in memory survives, and the work carries on from the database.
    reembed._forget_active()
    assert reembed.status()["reembed"]["done"] == 1
    assert reembed.run() >= 1

    st = reembed.status()
    assert st["active_model_key"] == NEW and st["reembed"]["status"] == "idle"
    assert st["reembed"]["percent"] == 100 and st["reembed"]["finished_at"]
    assert _vectors(OLD) == 0 and _vectors(NEW) == old_count
    res = _vector_search("impeller blocked")
    assert res["embedder"] == NEW
    assert res["hits"][0]["source_id"] == ids["Pump manual"]


def test_sources_added_during_a_reembed_are_found_before_and_after_the_swap() -> None:
    _ingest_with_old_model()
    embed.set_embedder(embed.HashEmbedder(64))
    reembed.check(download=False)
    reembed.step(batch=1)
    late = add_text_source(
        "ws", "Kestrel bridge", "# Kestrel bridge\n\nThe Kestrel Bridge spans the river Wend for 412 metres."
    )
    drain()
    with sessions().begin() as db:
        keys = {
            r[0]
            for r in db.execute(
                text(
                    "SELECT DISTINCT e.model_key FROM knowledge.chunk_embeddings e "
                    "JOIN knowledge.chunks c ON c.id = e.chunk_id WHERE c.source_id = :id"
                ),
                {"id": late},
            )
        }
    assert keys == {OLD, NEW}
    assert _vector_search("Kestrel Bridge river Wend")["hits"][0]["source_id"] == late
    reembed.run()
    res = _vector_search("Kestrel Bridge river Wend")
    assert res["embedder"] == NEW and res["hits"][0]["source_id"] == late


def test_going_back_to_the_active_model_cancels_the_reembed() -> None:
    _ingest_with_old_model()
    embed.set_embedder(embed.HashEmbedder(64))
    reembed.check(download=False)
    embed.set_embedder(embed.HashEmbedder(256))
    st = reembed.check(download=False)
    assert st["active_model_key"] == OLD and st["reembed"]["status"] == "idle"
    assert st["reembed"]["target_model_key"] is None
    assert reembed.step() is False


def test_first_run_adopts_the_model_that_already_has_vectors() -> None:
    add_text_source("ws", "Owls", DOCS["Owls"])
    drain()  # embedded with test/hash-256, but nothing adopted yet
    reembed.reset_index()
    embed.set_embedder(embed.HashEmbedder(64))
    st = reembed.check(download=False)
    # The existing vectors stay in use, and a re-embed to the configured model starts.
    assert st["active_model_key"] == OLD
    assert st["reembed"]["status"] == "running" and st["reembed"]["target_model_key"] == NEW


def test_progress_is_served_and_a_check_can_be_asked_for() -> None:
    _ingest_with_old_model()
    embed.set_embedder(embed.HashEmbedder(64))
    with TestClient(create_app()) as client:
        r = client.post("/kn/v1/embeddings/check", headers=AUTH)
        assert r.status_code == 200
        assert r.json()["reembed"]["status"] == "running"
        r = client.get("/kn/v1/embeddings", headers=AUTH)
        body = r.json()
        assert body["active_model_key"] == OLD and body["configured_model_key"] == NEW
        assert body["reembed"]["total"] > 0
        assert client.get("/kn/v1/embeddings").status_code == 401
