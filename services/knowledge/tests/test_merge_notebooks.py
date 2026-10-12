"""
The knowledge half of a notebook merge (docs/notebooks.md): preview,
merge (links move, a copy with the same content merges into A's, another
version is kept) and undo, which puts every link and copy back.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from ancile_knowledge.main import create_app
from ancile_knowledge.settings import get_settings
from tests.conftest import AUTH
from tests.test_routes_sources import ARTICLE, add_text, wait_for


@pytest.fixture
def client(kdb, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(get_settings(), "worker_enabled", True)
    with TestClient(create_app()) as c:
        yield c


def ids(client: TestClient, nb: str) -> set[str]:
    return {s["id"] for s in client.get(f"/kn/v1/notebooks/{nb}/sources", headers=AUTH).json()}


def test_preview_merge_and_undo(client: TestClient) -> None:
    # A holds the article and a shared source; B holds a copy of the article, the shared source,
    # another version of A's "Pumps" note, and one of its own.
    a_article = add_text(client, notebook_id="nb-a")["id"]
    shared = add_text(
        client, body="Shared reading list for both teams.", title="Reading", notebook_id="nb-a"
    )["id"]
    a_pumps = add_text(client, body="Pumps run at 40 bar.", title="Pumps", notebook_id="nb-a")["id"]
    b_copy = add_text(client, notebook_id="nb-b")["id"]
    b_pumps = add_text(client, body="Pumps now run at 45 bar.", title="Pumps", notebook_id="nb-b")["id"]
    b_own = add_text(client, body="Kites fly on wind over the bay.", title="Kites", notebook_id="nb-b")["id"]
    for sid in (a_article, shared, a_pumps, b_copy, b_pumps, b_own):
        wait_for(client, sid)
    assert client.put(f"/kn/v1/notebooks/nb-b/sources/{shared}", json={}, headers=AUTH).status_code == 200

    r = client.get("/kn/v1/notebooks/nb-a/merge-preview?from=nb-b&workspace_id=ws", headers=AUTH)
    assert r.status_code == 200, r.text
    p = r.json()
    assert {m["id"] for m in p["move"]} == {b_pumps, b_own}
    assert [m["id"] for m in p["already"]] == [shared]
    assert p["duplicates"] == [
        {"id": b_copy, "title": "Tidal energy", "into_id": a_article, "into_title": "Tidal energy"}
    ]
    assert p["versions"] == [{"id": b_pumps, "title": "Pumps", "into_id": a_pumps}]
    # A preview changes nothing.
    assert ids(client, "nb-b") == {b_copy, shared, b_pumps, b_own}

    r = client.post(
        "/kn/v1/notebooks/nb-a/merge", json={"from_id": "nb-b", "workspace_id": "ws"}, headers=AUTH
    )
    assert r.status_code == 200, r.text
    rec = r.json()
    assert {m["source_id"] for m in rec["moved"]} == {b_pumps, b_own}
    assert rec["merged"] == [
        {
            "source_id": b_copy,
            "into_id": a_article,
            "title": "Tidal energy",
            "kind": "text",
            "context_level": "full",
            "deleted": True,
        }
    ]
    assert ids(client, "nb-a") == {a_article, shared, a_pumps, b_pumps, b_own}
    assert ids(client, "nb-b") == set()
    # The copy is gone from search and lists; A's copy answers for it.
    assert client.get(f"/kn/v1/sources/{b_copy}", headers=AUTH).status_code == 404

    r = client.post(
        "/kn/v1/notebooks/nb-a/merge/undo",
        json={"from_id": "nb-b", "workspace_id": "ws", "record": rec},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    assert ids(client, "nb-b") == {b_copy, shared, b_pumps, b_own}
    assert ids(client, "nb-a") == {a_article, shared, a_pumps}
    assert client.get(f"/kn/v1/sources/{b_copy}", headers=AUTH).status_code == 200


def test_a_copy_another_notebook_holds_is_kept(client: TestClient) -> None:
    a = add_text(client, notebook_id="nb-a2")["id"]
    b = add_text(client, body=ARTICLE, notebook_id="nb-b2")["id"]
    wait_for(client, a)
    wait_for(client, b)
    assert client.put(f"/kn/v1/notebooks/nb-c2/sources/{b}", json={}, headers=AUTH).status_code == 200
    rec = client.post(
        "/kn/v1/notebooks/nb-a2/merge", json={"from_id": "nb-b2", "workspace_id": "ws"}, headers=AUTH
    ).json()
    assert rec["merged"][0]["deleted"] is False
    # Still readable, still in the third notebook; it just left B.
    assert client.get(f"/kn/v1/sources/{b}", headers=AUTH).status_code == 200
    assert ids(client, "nb-c2") == {b}
    assert ids(client, "nb-a2") == {a}
