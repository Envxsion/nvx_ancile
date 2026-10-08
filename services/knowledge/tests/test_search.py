"""
Search: hybrid ordering, strict scoping (workspace, notebook, source list),
context levels off / insights / full, and deleted sources never returned.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from ancile_knowledge.main import create_app
from ancile_knowledge.search.service import Query, search
from tests.conftest import AUTH, add_text_source, drain

pytestmark = pytest.mark.usefixtures("kdb")

OWLS = (
    "# Owls\n\nOwls are nocturnal birds of prey. Their soft feathers let them fly silently, "
    "and their large eyes gather light for hunting at night.\n\n## Diet\n\nOwls eat small mammals, "
    "insects and other birds, swallowing prey whole and coughing up pellets."
)
PUMP = (
    "# Pump manual\n\nThe ZX-4410 pump must be primed before first use. Open valve V2, fill the housing, "
    "then close V2.\n\n## Faults\n\nError code E-17 means the impeller is blocked; switch off and clear it."
)
BREAD = (
    "# Sourdough\n\nA sourdough starter is a culture of wild yeast and lactic acid bacteria. "
    "Feed it flour and water daily and keep it warm so the dough rises well."
)


def _sids(hits: list[dict[str, object]]) -> set[object]:
    return {h["source_id"] for h in hits}


def test_hybrid_puts_exact_keyword_matches_first() -> None:
    owls = add_text_source("ws", "Owls", OWLS)
    pump = add_text_source("ws", "Pump manual", PUMP)
    add_text_source("ws", "Sourdough", BREAD)
    drain()
    res = search(Query(workspace_id="ws", query="ZX-4410 priming", k=5))
    assert res["mode"] == "hybrid" and res["embedder"] == "test/hash-256"
    top = res["hits"][0]
    assert top["source_id"] == pump and top["kind"] == "chunk"
    assert top["ranks"]["text"] == 1 and top["ranks"]["vector"] is not None
    assert res["hits"][0]["score"] >= res["hits"][-1]["score"]

    res = search(Query(workspace_id="ws", query="which birds hunt at night", k=3))
    assert res["hits"][0]["source_id"] == owls


def test_hits_carry_exact_spans() -> None:
    sid = add_text_source("ws", "Pump manual", PUMP)
    drain()
    for h in search(Query(workspace_id="ws", query="impeller blocked", k=5))["hits"]:
        assert h["source_id"] == sid
        assert PUMP[h["char_start"] : h["char_end"]] == h["text"]
        assert h["heading_path"][0] == "Pump manual"


def test_modes_text_and_vector() -> None:
    add_text_source("ws", "Pump manual", PUMP)
    drain()
    t = search(Query(workspace_id="ws", query="impeller", mode="text"))
    assert t["mode"] == "text" and t["embedder"] is None
    assert all(h["ranks"]["vector"] is None and h["ranks"]["text"] for h in t["hits"])
    v = search(Query(workspace_id="ws", query="impeller", mode="vector"))
    assert v["mode"] == "vector"
    assert all(h["ranks"]["text"] is None and h["ranks"]["vector"] for h in v["hits"])


def test_workspace_scoping_never_leaks() -> None:
    mine = add_text_source("ws-a", "Pump manual", PUMP)
    theirs = add_text_source("ws-b", "Pump manual", PUMP)
    drain()
    for mode in ("hybrid", "text", "vector"):
        res = search(Query(workspace_id="ws-a", query="ZX-4410 pump impeller", mode=mode, k=50))
        assert _sids(res["hits"]) == {mine}
    assert theirs not in _sids(search(Query(workspace_id="ws-a", query="pump", source_ids=[theirs]))["hits"])


def test_notebook_scoping_never_leaks_other_notebooks() -> None:
    a = add_text_source("ws", "Owls", OWLS, {"nb-1": "full"})
    b = add_text_source("ws", "Owls copy", OWLS, {"nb-2": "full"})
    c = add_text_source("ws", "Unfiled owls", OWLS)
    drain()
    for mode in ("hybrid", "text", "vector"):
        res = search(
            Query(workspace_id="ws", query="owls hunting at night", notebook_id="nb-1", mode=mode, k=50)
        )
        assert _sids(res["hits"]) == {a}
    everywhere = search(Query(workspace_id="ws", query="owls hunting at night", k=50))
    assert _sids(everywhere["hits"]) == {a, b, c}
    # A notebook in another workspace with the same id still cannot see this workspace.
    assert search(Query(workspace_id="other", query="owls", notebook_id="nb-1"))["hits"] == []


def test_context_levels_full_insights_off(kdb) -> None:  # type: ignore[no-untyped-def]
    sid = add_text_source("ws", "Owls", OWLS, {"nb": "full"})
    drain()
    q = Query(workspace_id="ws", query="owls feathers fly silently", notebook_id="nb", k=10)
    full = search(q)["hits"]
    assert full and all(h["kind"] == "chunk" for h in full)

    with kdb().begin() as db:
        db.execute(text("UPDATE knowledge.notebook_sources SET context_level = 'insights'"))
    ins = search(q)["hits"]
    assert len(ins) == 1
    hit = ins[0]
    assert hit["kind"] == "insight" and hit["source_id"] == sid
    assert (
        hit["char_start"] == 0 and hit["char_end"] == 0 and hit["heading_path"] == [] and hit["page"] is None
    )
    assert "nocturnal" in hit["text"]

    with kdb().begin() as db:
        db.execute(text("UPDATE knowledge.notebook_sources SET context_level = 'off'"))
    assert search(q)["hits"] == []


def test_deleted_and_unready_sources_are_excluded(kdb) -> None:  # type: ignore[no-untyped-def]
    gone = add_text_source("ws", "Pump manual", PUMP)
    drain()
    queued = add_text_source("ws", "Pump manual two", PUMP)  # never processed
    with kdb().begin() as db:
        db.execute(text("UPDATE knowledge.sources SET deleted_at = now() WHERE id = :id"), {"id": gone})
    res = search(Query(workspace_id="ws", query="ZX-4410", k=20))
    assert gone not in _sids(res["hits"]) and queued not in _sids(res["hits"])
    assert res["hits"] == []


def test_source_ids_filter() -> None:
    owls = add_text_source("ws", "Owls", OWLS)
    pump = add_text_source("ws", "Pump manual", PUMP)
    drain()
    res = search(Query(workspace_id="ws", query="owls pump", source_ids=[pump], k=20))
    assert _sids(res["hits"]) == {pump}
    assert owls not in _sids(res["hits"])


def test_search_endpoint_shape() -> None:
    add_text_source("ws", "Pump manual", PUMP)
    drain()
    client = TestClient(create_app())
    r = client.post("/kn/v1/search", json={"workspace_id": "ws", "query": "E-17 fault"}, headers=AUTH)
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"hits", "mode", "embedder", "ms"}
    assert set(body["hits"][0]) == {
        "kind", "chunk_id", "source_id", "source_title", "text", "heading_path", "page",
        "char_start", "char_end", "score", "rerank_score", "ranks",
    }  # fmt: skip
    assert body["hits"][0]["rerank_score"] is None  # identity reranker in tests


def test_reranker_reorders_and_scores(monkeypatch: pytest.MonkeyPatch) -> None:
    from ancile_knowledge.search import rerank

    add_text_source("ws", "Owls", OWLS)
    add_text_source("ws", "Pump manual", PUMP)
    drain()

    class PreferPump:
        model_key = "test/prefer-pump"

        def rerank(self, query: str, docs: list[tuple[str, str]]) -> list[rerank.Scored]:
            return sorted(
                (rerank.Scored(i, 0.9 if "pump" in t.lower() else 0.1) for i, t in docs),
                key=lambda s: -s.score,
            )

    rerank.set_reranker(PreferPump())
    hits = search(Query(workspace_id="ws", query="owls", k=5))["hits"]
    assert "pump" in hits[0]["text"].lower() and hits[0]["rerank_score"] == 0.9
