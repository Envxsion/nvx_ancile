"""
Track G, knowledge side: a cited passage is current, changed or removed;
each source's language is detected at ingest; a notebook that mixes
languages under an English-only embedder is offered a multilingual one.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from ancile_knowledge.ingest import fetch, pipeline
from ancile_knowledge.main import create_app
from ancile_knowledge.settings import get_settings
from ancile_knowledge.sources import language
from tests.conftest import AUTH, make_pdf
from tests.test_routes_sources import add_text, wait_for

ENGLISH = (
    "# Pumps\n\nThe P-300 pump moves forty litres a minute at full speed. It needs a service every "
    "six hundred running hours, or once a year, whichever comes first."
)
FRENCH = (
    "# Pompes\n\nLa pompe P-300 déplace quarante litres par minute à pleine vitesse. Elle doit être "
    "entretenue toutes les six cents heures de marche, ou une fois par an."
)


def sha(t: str) -> str:
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


# --- language detection (no database) -----------------------------------------------


def test_detects_the_main_language() -> None:
    assert language.detect(ENGLISH) == "en"
    assert language.detect(FRENCH) == "fr"
    german = "Die Pumpe fördert vierzig Liter pro Minute und muss jährlich gewartet werden."
    assert language.detect(german) == "de"


def test_too_little_text_or_only_code_is_unknown() -> None:
    assert language.detect("ok") is None
    assert language.detect("```\nconst x = 1;\nconst y = 2;\n```\n") is None
    assert language.detect("") is None


def test_long_text_is_sampled_start_middle_end() -> None:
    long = FRENCH * 50 + ENGLISH * 200 + FRENCH * 50
    parts = language.samples(long)
    assert len(parts) == 3 and all(len(p) == language.SAMPLE_CHARS for p in parts)


def test_multilingual_models_are_recognised() -> None:
    assert not language.is_multilingual("BAAI/bge-small-en-v1.5")
    assert language.is_multilingual("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
    assert language.is_multilingual("intfloat/multilingual-e5-large")
    assert language.is_multilingual(get_settings().multilingual_embed_model)


# --- with the database and the worker -------------------------------------------------


@pytest.fixture
def client(kdb, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(get_settings(), "worker_enabled", True)
    with TestClient(create_app()) as c:
        yield c


def chunks_of(kdb: Any, source_id: str) -> list[dict[str, Any]]:
    with kdb().begin() as db:
        return [
            dict(r)
            for r in db.execute(
                text(
                    "SELECT c.id, c.text FROM knowledge.chunks c "
                    "JOIN knowledge.sources s ON s.id = c.source_id AND c.version = s.current_version "
                    "WHERE c.source_id = :id AND c.parent_id IS NOT NULL "
                    "ORDER BY c.ordinal"
                ),
                {"id": source_id},
            ).mappings()
        ]


def check(client: TestClient, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    r = client.post("/kn/v1/passages/check", json={"workspace_id": "ws", "items": items}, headers=AUTH)
    assert r.status_code == 200, r.text
    return list(r.json()["items"])


def test_passage_current_changed_and_removed(client: TestClient, kdb) -> None:  # type: ignore[no-untyped-def]
    src = wait_for(client, add_text(client, ENGLISH)["id"])
    assert src["language"] == "en"
    c = chunks_of(kdb, src["id"])[0]

    same, other, old = check(
        client,
        [
            {"ref": c["id"], "source_id": src["id"], "text_sha256": sha(c["text"])},
            {"ref": c["id"], "source_id": src["id"], "text_sha256": sha("something else")},
            {"ref": c["id"], "source_id": src["id"], "text_sha256": None},
        ],
    )
    assert same["state"] == "current" and same["source_title"] == "Pumps" and same["deleted_at"] is None
    assert other["state"] == "changed"
    assert old["state"] == "current"  # a citation from before the hash: in the current version is enough

    # Another workspace cannot see it, and an unknown source reads as removed.
    r = client.post(
        "/kn/v1/passages/check",
        json={"workspace_id": "other", "items": [{"ref": c["id"], "source_id": src["id"]}]},
        headers=AUTH,
    )
    assert r.json()["items"][0]["state"] == "removed" and r.json()["items"][0]["source_title"] is None

    assert client.delete(f"/kn/v1/sources/{src['id']}", headers=AUTH).status_code == 204
    [gone] = check(client, [{"ref": c["id"], "source_id": src["id"], "text_sha256": sha(c["text"])}])
    assert gone["state"] == "removed" and gone["source_title"] == "Pumps" and gone["deleted_at"]


def test_a_refetched_source_flags_only_passages_that_changed(
    client: TestClient, kdb, monkeypatch: pytest.MonkeyPatch
) -> None:  # type: ignore[no-untyped-def]
    page = {"body": "<p>Tidal turbines generate electricity from moving water.</p>", "etag": '"v1"'}

    def handler(request: httpx.Request) -> httpx.Response:
        html = (
            "<html><head><title>Tides</title></head><body><article><h1>Tides</h1>"
            f"{page['body']}</article></body></html>"
        )
        return httpx.Response(200, text=html, headers={"content-type": "text/html", "etag": page["etag"]})

    monkeypatch.setattr(fetch, "transport", httpx.MockTransport(handler))
    monkeypatch.setattr(fetch, "resolve_host", lambda h: ["93.184.216.34"])
    r = client.post(
        "/kn/v1/sources",
        json={"workspace_id": "ws", "kind": "url", "url": "https://tides.example/"},
        headers=AUTH,
    )
    sid = wait_for(client, r.json()["id"])["id"]
    before = chunks_of(kdb, sid)[0]
    cited = {"ref": before["id"], "source_id": sid, "text_sha256": sha(before["text"])}
    assert check(client, [cited])[0]["state"] == "current"

    # The page is edited and fetched again: the old chunk is gone and its text with it.
    page.update(
        body="<p>Tidal lagoons hold water behind a wall and release it through turbines.</p>", etag='"v2"'
    )
    assert client.post(f"/kn/v1/sources/{sid}/refetch", headers=AUTH).status_code == 200
    wait_for(client, sid)
    assert client.get(f"/kn/v1/sources/{sid}/content", headers=AUTH).json()["version"] == 2
    assert check(client, [cited])[0]["state"] == "changed"

    # Fetched again with the original text: a new chunk id, the same words. Still what was cited.
    page.update(body="<p>Tidal turbines generate electricity from moving water.</p>", etag='"v3"')
    client.post(f"/kn/v1/sources/{sid}/refetch", headers=AUTH)
    wait_for(client, sid)
    assert chunks_of(kdb, sid)[0]["id"] != before["id"]
    assert check(client, [cited])[0]["state"] == "current"


def test_a_large_source_is_read_in_the_background_with_progress(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The upload answers at once; the Sources panel then sees page and passage counts move."""
    events: list[dict[str, Any]] = []
    real_publish = pipeline.publish

    def record(db: Any, event: dict[str, object]) -> None:
        events.append(dict(event))
        real_publish(db, event)

    monkeypatch.setattr(pipeline, "publish", record)
    monkeypatch.setattr(pipeline, "PROGRESS_MIN_INTERVAL_S", 0.0)
    line = "Page {} of the pump service manual: inspect seal {} and log the pressure."
    pages = [[line.format(i, i)] for i in range(60)]
    r = client.post(
        "/kn/v1/sources/upload",
        files={"file": ("manual.pdf", make_pdf(pages), "application/pdf")},
        data={"workspace_id": "ws", "notebook_ids": "nb-big"},
        headers=AUTH,
    )
    assert r.status_code == 201 and r.json()["status"] != "ready"  # not read inside the request
    src = wait_for(client, r.json()["id"])
    assert src["pages"] == 60 and src["language"] == "en"

    mine = [e for e in events if e.get("source_id") == src["id"]]
    pages_seen = [e for e in mine if e["stage"] == "extracting" and e.get("total") == 60]
    assert len(pages_seen) >= 30
    assert any(e["message"] == "Extracting page 30 of 60" for e in pages_seen)
    assert any(e["stage"] == "embedding" and e.get("total") for e in mine)
    assert mine[-1]["stage"] == "ready"


def test_notebook_languages_and_the_multilingual_hint(client: TestClient) -> None:
    en = add_text(client, ENGLISH, notebook_id="nb-lang")
    fr = add_text(client, FRENCH, notebook_id="nb-lang")
    assert wait_for(client, en["id"])["language"] == "en"
    assert wait_for(client, fr["id"])["language"] == "fr"

    body = client.get("/kn/v1/notebooks/nb-lang/languages?workspace_id=ws", headers=AUTH).json()
    assert body["mixed"] is True
    assert sorted(lang["code"] for lang in body["languages"]) == ["en", "fr"]
    assert body["embedder"] == {"model": get_settings().embed_model, "multilingual": False}
    assert body["multilingual_option"] == get_settings().multilingual_embed_model

    # One language only: nothing to suggest.
    client.delete(f"/kn/v1/sources/{fr['id']}", headers=AUTH)
    body = client.get("/kn/v1/notebooks/nb-lang/languages?workspace_id=ws", headers=AUTH).json()
    assert body["mixed"] is False and body["languages"] == [{"code": "en", "sources": 1}]
