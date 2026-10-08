"""
/kn/v1 sources end to end, with the in-process worker running: add text, URL
(mocked network) and uploads until ready; content offsets; duplicate
suggestions, merge and dismiss; notebook links; stale check and refetch;
retry; delete.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from ancile_knowledge.ingest import fetch
from ancile_knowledge.main import create_app
from ancile_knowledge.settings import get_settings
from tests.conftest import AUTH, make_pdf

ARTICLE = (
    "# Tidal energy\n\nTidal power converts the energy of tides into electricity. Barrage schemes such as "
    "La Rance in France have run since 1966, while newer tidal stream turbines sit on the seabed.\n\n"
    "## Costs\n\nTidal stream projects remain expensive, but predictable output makes tidal energy "
    "attractive "
    "to grid operators who balance wind and solar.\n\n## Environment\n\nTurbines can affect fish and marine "
    "mammals; monitoring at MeyGen in Scotland studies collision risk for tidal turbines."
)

FIELDS = {
    "id", "kind", "title", "uri", "mime", "bytes", "status", "progress", "error", "tags", "summary", "chunks",
    "pages", "stale", "fetched_at", "created_at", "updated_at", "duplicate_of",
}  # fmt: skip


@pytest.fixture
def client(kdb, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(get_settings(), "worker_enabled", True)
    with TestClient(create_app()) as c:
        yield c


def wait_for(client: TestClient, sid: str, status: str = "ready", timeout: float = 30) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    body: dict[str, Any] = {}
    while time.monotonic() < deadline:
        body = client.get(f"/kn/v1/sources/{sid}", headers=AUTH).json()
        if body.get("status") == status:
            return body
        if body.get("status") == "failed" and status != "failed":
            raise AssertionError(f"source failed: {body.get('error')}")
        time.sleep(0.1)
    raise AssertionError(f"timed out waiting for {status}: {body}")


def add_text(client: TestClient, body: str = ARTICLE, **extra: Any) -> dict[str, Any]:
    r = client.post(
        "/kn/v1/sources", json={"workspace_id": "ws", "kind": "text", "text": body, **extra}, headers=AUTH
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_requires_service_token(client: TestClient) -> None:
    r = client.get("/kn/v1/sources?workspace_id=ws")
    assert r.status_code == 401 and r.json()["error"]["code"] == "auth.service_token_invalid"


def test_add_text_to_ready_with_exact_content_offsets(client: TestClient, kdb) -> None:  # type: ignore[no-untyped-def]
    created = add_text(client, notebook_id="nb-1")
    assert set(created) == FIELDS and created["title"] == "Tidal energy"
    assert created["status"] in ("queued", "extracting", "enriching", "embedding", "ready")
    src = wait_for(client, created["id"])
    assert src["chunks"] > 0 and src["pages"] is None and src["error"] is None
    assert src["summary"] and src["summary"].startswith("Tidal power converts")
    assert "tidal" in src["tags"] and len(src["tags"]) <= 5
    assert src["progress"]["stage"] == "ready"

    content = client.get(f"/kn/v1/sources/{src['id']}/content", headers=AUTH).json()
    md = content["markdown"]
    assert md == ARTICLE and content["version"] == 1 and content["pages"] == []
    assert [o["title"] for o in content["outline"]] == ["Tidal energy", "Costs", "Environment"]
    for o in content["outline"]:
        assert md[o["char_start"] :].startswith("#")
    with kdb().begin() as db:
        rows = db.execute(
            text("SELECT text, char_start, char_end FROM knowledge.chunks WHERE source_id = :id"),
            {"id": src["id"]},
        ).all()
    assert rows and all(md[s:e] == t for t, s, e in rows)

    listed = client.get("/kn/v1/notebooks/nb-1/sources", headers=AUTH).json()
    assert [s["id"] for s in listed] == [src["id"]] and listed[0]["context_level"] == "full"
    stats = client.get("/kn/v1/notebooks/nb-1/stats", headers=AUTH).json()
    assert stats == {"sources": 1, "ready": 1, "chunks": src["chunks"]}


def test_thread_source_keeps_thread_id(client: TestClient) -> None:
    r = client.post(
        "/kn/v1/sources",
        json={
            "workspace_id": "ws",
            "kind": "thread",
            "thread_id": "thr_1",
            "text": "User: hi\n\nAssistant: hello",
        },
        headers=AUTH,
    )
    assert r.status_code == 201
    src = wait_for(client, r.json()["id"])
    assert src["kind"] == "thread" and src["uri"] == "thr_1"


def test_url_source_fetches_tags_and_goes_stale(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    state = {"etag": '"v1"', "body": "Tidal turbines generate electricity from moving water. " * 10}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers.get("if-none-match") == state["etag"]:
            return httpx.Response(304, headers={"etag": state["etag"]})
        html = (
            "<html><head><title>Tidal turbines explained</title></head><body><article><h1>Tidal turbines</h1>"
            f"<p>{state['body']}</p></article></body></html>"
        )
        return httpx.Response(200, text=html, headers={"content-type": "text/html", "etag": state["etag"]})

    monkeypatch.setattr(fetch, "transport", httpx.MockTransport(handler))
    monkeypatch.setattr(fetch, "resolve_host", lambda h: ["93.184.216.34"])
    r = client.post(
        "/kn/v1/sources",
        json={"workspace_id": "ws", "kind": "url", "url": "https://energy.example/tidal"},
        headers=AUTH,
    )
    assert r.status_code == 201
    src = wait_for(client, r.json()["id"])
    assert src["title"] == "Tidal turbines explained" and src["fetched_at"] and "tidal" in src["tags"]
    assert src["stale"] is False

    # Unchanged page: the conditional check answers 304, still fresh.
    check = client.post("/kn/v1/maintenance/stale-check", json={"force": True}, headers=AUTH).json()
    assert check["checked"] == 1 and check["fresh"] == 1
    # The page changes upstream: the ETag differs, so the source is marked stale.
    state.update(
        etag='"v2"', body="Tidal lagoons store water behind a wall and release it through turbines. " * 10
    )
    check = client.post("/kn/v1/maintenance/stale-check", json={"force": True}, headers=AUTH).json()
    assert check["stale"] == 1
    assert client.get(f"/kn/v1/sources/{src['id']}", headers=AUTH).json()["stale"] is True

    r = client.post(f"/kn/v1/sources/{src['id']}/refetch", headers=AUTH)
    assert r.status_code == 200 and r.json()["stale"] is False
    wait_for(client, src["id"])
    content = client.get(f"/kn/v1/sources/{src['id']}/content", headers=AUTH).json()
    assert content["version"] == 2 and "lagoons" in content["markdown"]


def test_url_to_private_host_fails_and_retry_succeeds(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(fetch, "resolve_host", lambda h: ["10.0.0.7"])
    monkeypatch.setattr(
        fetch,
        "transport",
        httpx.MockTransport(lambda r: httpx.Response(200, text="Plain words about kites. " * 20)),
    )
    sid = client.post(
        "/kn/v1/sources",
        json={"workspace_id": "ws", "kind": "url", "url": "http://wiki.corp/kites"},
        headers=AUTH,
    ).json()["id"]
    failed = wait_for(client, sid, "failed")
    assert failed["error"]["code"] == "extract.url_blocked" and failed["error"]["hint"]

    monkeypatch.setattr(fetch, "resolve_host", lambda h: ["93.184.216.34"])
    r = client.post(f"/kn/v1/sources/{sid}/retry", headers=AUTH)
    assert r.status_code == 200 and r.json()["error"] is None
    assert wait_for(client, sid)["chunks"] > 0
    assert client.post(f"/kn/v1/sources/{sid}/retry", headers=AUTH).status_code == 409


def test_upload_pdf_and_text_file(client: TestClient) -> None:
    pdf = make_pdf([["Page one about otters."], ["Page two about beavers building dams."]])
    r = client.post(
        "/kn/v1/sources/upload",
        files={"file": ("animals.pdf", pdf, "application/pdf")},
        data={"workspace_id": "ws", "notebook_ids": "nb-a,nb-b"},
        headers=AUTH,
    )
    assert r.status_code == 201, r.text
    src = wait_for(client, r.json()["id"])
    assert (
        src["kind"] == "file"
        and src["uri"] == "animals.pdf"
        and src["pages"] == 2
        and src["bytes"] == len(pdf)
    )
    content = client.get(f"/kn/v1/sources/{src['id']}/content", headers=AUTH).json()
    p2 = content["pages"][1]
    assert content["markdown"][p2["char_start"] : p2["char_end"]] == "Page two about beavers building dams."
    original = client.get(f"/kn/v1/sources/{src['id']}/file", headers=AUTH)
    assert original.status_code == 200 and original.content == pdf
    assert len(client.get("/kn/v1/notebooks/nb-b/sources", headers=AUTH).json()) == 1

    r = client.post(
        "/kn/v1/sources/upload",
        files={"file": ("notes.md", b"# Notes\n\nRemember the otters.", "text/markdown")},
        data={"workspace_id": "ws", "title": "My notes"},
        headers=AUTH,
    )
    src = wait_for(client, r.json()["id"])
    assert src["title"] == "My notes" and src["mime"] == "text/markdown"


def test_upload_limit(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "max_upload_mb", 0)
    r = client.post(
        "/kn/v1/sources/upload",
        files={"file": ("big.txt", b"x" * 10, "text/plain")},
        data={"workspace_id": "ws"},
        headers=AUTH,
    )  # fmt: skip
    assert r.status_code == 413 and r.json()["error"]["code"] == "source.too_large"


def test_duplicates_merge_and_dismiss(client: TestClient) -> None:
    first = add_text(client, notebook_id="nb-1")
    wait_for(client, first["id"])
    second = add_text(client, notebook_id="nb-2")
    dup = wait_for(client, second["id"])["duplicate_of"]
    assert dup == {"source_id": first["id"], "title": "Tidal energy", "kind": "duplicate", "score": 1.0}

    listed = client.get("/kn/v1/duplicates?workspace_id=ws", headers=AUTH).json()
    assert len(listed) == 1 and listed[0]["a_id"] == second["id"] and listed[0]["b_id"] == first["id"]

    r = client.post(
        "/kn/v1/sources/merge", json={"keep_id": first["id"], "drop_id": second["id"]}, headers=AUTH
    )
    assert r.status_code == 200 and r.json()["id"] == first["id"]
    assert client.get(f"/kn/v1/sources/{second['id']}", headers=AUTH).status_code == 404
    nb2 = client.get("/kn/v1/notebooks/nb-2/sources", headers=AUTH).json()
    assert [s["id"] for s in nb2] == [first["id"]]
    assert client.get("/kn/v1/duplicates?workspace_id=ws", headers=AUTH).json() == []

    # A near-copy of a longer text: suggested as a near duplicate, then dismissed.
    long_text = " ".join(f"Note {i} records gauge {i * 3} on the river at mile {i + 7}." for i in range(80))
    base = add_text(client, body=long_text)
    wait_for(client, base["id"])
    near = add_text(client, body=long_text.replace("gauge 30 ", "gauge 31 "))
    dup = wait_for(client, near["id"])["duplicate_of"]
    assert dup is not None and dup["kind"] == "near_duplicate" and dup["score"] >= 0.9
    assert dup["source_id"] == base["id"]
    r = client.post("/kn/v1/duplicates/dismiss", json={"a_id": base["id"], "b_id": near["id"]}, headers=AUTH)
    assert r.status_code == 204
    assert client.get(f"/kn/v1/sources/{near['id']}", headers=AUTH).json()["duplicate_of"] is None


def test_patch_link_levels_and_delete(client: TestClient) -> None:
    sid = add_text(client)["id"]
    wait_for(client, sid)
    r = client.patch(
        f"/kn/v1/sources/{sid}", json={"title": "Tides", "tags": ["energy", "sea"]}, headers=AUTH
    )
    assert r.json()["title"] == "Tides" and r.json()["tags"] == ["energy", "sea"]

    r = client.put(f"/kn/v1/notebooks/nb/sources/{sid}", json={}, headers=AUTH)
    assert r.json()["context_level"] == "full"
    r = client.put(f"/kn/v1/notebooks/nb/sources/{sid}", json={"context_level": "insights"}, headers=AUTH)
    assert r.json()["context_level"] == "insights"
    search = {"workspace_id": "ws", "query": "tidal turbines", "notebook_id": "nb"}
    hits = client.post("/kn/v1/search", json=search, headers=AUTH).json()["hits"]
    assert [h["kind"] for h in hits] == ["insight"]

    assert client.delete(f"/kn/v1/notebooks/nb/sources/{sid}", headers=AUTH).status_code == 204
    assert client.get("/kn/v1/notebooks/nb/sources", headers=AUTH).json() == []

    assert client.delete(f"/kn/v1/sources/{sid}", headers=AUTH).status_code == 204
    assert client.get(f"/kn/v1/sources/{sid}", headers=AUTH).status_code == 404
    assert client.get("/kn/v1/sources?workspace_id=ws", headers=AUTH).json() == []
    hits = client.post("/kn/v1/search", json={"workspace_id": "ws", "query": "tidal"}, headers=AUTH).json()[
        "hits"
    ]
    assert hits == []


def test_list_by_ids_and_workspace_guard(client: TestClient) -> None:
    a = add_text(client)["id"]
    b = add_text(client, body="Kites fly on wind.")["id"]
    listed = client.get(f"/kn/v1/sources?ids={a},{b}", headers=AUTH).json()
    assert {s["id"] for s in listed} == {a, b}
    assert client.get(f"/kn/v1/sources/{a}?workspace_id=other", headers=AUTH).status_code == 404
    r = client.get("/kn/v1/sources", headers=AUTH)
    assert r.status_code == 422


def test_invalid_add_requests(client: TestClient) -> None:
    for body in (
        {"workspace_id": "ws", "kind": "url"},
        {"workspace_id": "ws", "kind": "url", "url": "file:///etc/passwd"},
        {"workspace_id": "ws", "kind": "text", "text": "   "},
        {"workspace_id": "ws", "kind": "thread", "text": "x"},
    ):
        r = client.post("/kn/v1/sources", json=body, headers=AUTH)
        assert r.status_code == 422 and r.json()["error"]["hint"], body
