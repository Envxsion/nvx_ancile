"""
ROADMAP MT1, knowledge side: Tidy storage removes chunks of old versions that a
newer chunk repeats (by content hash), links identical old version bodies, leaves
the current version alone, and waits while sources are being read.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from ancile_knowledge.db import sessions
from ancile_knowledge.main import create_app
from ancile_knowledge.sources import repo, tidy
from tests.conftest import AUTH

SID = "src_tidy"


def chunk(
    db, cid: str, version: int, ordinal: int, body: str, parent: str | None = None, blurb: str | None = None
):  # type: ignore[no-untyped-def]
    db.execute(
        text(
            "INSERT INTO knowledge.chunks (id, source_id, version, ordinal, parent_id, text, context_blurb, "
            "heading_path, char_start, char_end, tokens) VALUES (:id, :s, :v, :o, :p, :t, :b, '{}', 0, :n, 5)"
        ),
        {"id": cid, "s": SID, "v": version, "o": ordinal, "p": parent, "t": body, "b": blurb, "n": len(body)},
    )


def ids(db) -> set[str]:  # type: ignore[no-untyped-def]
    return {
        r[0] for r in db.execute(text("SELECT id FROM knowledge.chunks WHERE source_id = :s"), {"s": SID})
    }


@pytest.fixture
def seeded(kdb) -> Iterator[None]:  # type: ignore[no-untyped-def]
    """A source at version 3 whose older versions repeat some of its chunks."""
    with sessions().begin() as db:
        db.execute(
            text(
                "INSERT INTO knowledge.sources (id, workspace_id, kind, title, status, progress, "
                "tags, topics, "
                "current_version) VALUES (:id, 'ws', 'text', 'Tidal energy', 'ready', '{}', '{}', '{}', 3)"
            ),
            {"id": SID},
        )
        for v in (1, 2, 3):
            chunk(db, f"p{v}", v, 0, f"Parent of version {v}")
        # Version 1: A (repeated later), B (only here).
        chunk(db, "c1a", 1, 1, "Tides rise and fall twice a day.", "p1")
        chunk(db, "c1b", 1, 2, "Only version one says this.", "p1")
        # Version 2: A again, white space different; C repeated by version 3.
        chunk(db, "c2a", 2, 1, "Tides  rise and fall\ntwice a day.", "p2")
        chunk(db, "c2c", 2, 2, "Barrages hold back the tide.", "p2")
        # Version 3 (current): A and C.
        chunk(db, "c3a", 3, 1, "Tides rise and fall twice a day.", "p3")
        chunk(db, "c3c", 3, 2, "Barrages hold back the tide.", "p3")
        db.execute(
            text(
                "INSERT INTO knowledge.chunk_embeddings (chunk_id, model_key, embedding) "
                "VALUES ('c1a', 'm', '[0.1,0.2]'), ('c3a', 'm', '[0.1,0.2]')"
            )
        )
    yield


def test_removes_old_chunks_that_a_newer_one_repeats(seeded) -> None:  # type: ignore[no-untyped-def]
    out = tidy.tidy()
    assert out["chunks_removed"] == 3  # c1a, c2a, c2c
    assert out["parents_removed"] == 1  # p2 has no children left
    with sessions()() as db:
        assert ids(db) == {"p1", "p3", "c1b", "c3a", "c3c"}
        # Its embedding went with it; the current version's stays.
        left = {r[0] for r in db.execute(text("SELECT chunk_id FROM knowledge.chunk_embeddings"))}
        assert left == {"c3a"}


def test_the_current_version_is_never_touched_and_a_second_run_finds_nothing(seeded) -> None:  # type: ignore[no-untyped-def]
    tidy.tidy()
    with sessions()() as db:
        assert {"p3", "c3a", "c3c"} <= ids(db)
    again = tidy.tidy()
    assert again["chunks_removed"] == 0 and again["parents_removed"] == 0


def test_older_versions_that_repeat_each_other_keep_the_newest_copy(kdb) -> None:  # type: ignore[no-untyped-def]
    with sessions().begin() as db:
        db.execute(
            text(
                "INSERT INTO knowledge.sources (id, workspace_id, kind, title, status, progress, "
                "tags, topics, "
                "current_version) VALUES (:id, 'ws', 'text', 'T', 'ready', '{}', '{}', '{}', 3)"
            ),
            {"id": SID},
        )
        for v in (1, 2, 3):
            chunk(db, f"p{v}", v, 0, f"P{v}")
        chunk(db, "c1", 1, 1, "Same old words.", "p1")
        chunk(db, "c2", 2, 1, "Same old words.", "p2")
        chunk(db, "c3", 3, 1, "Fresh words.", "p3")
    tidy.tidy()
    with sessions()() as db:
        assert ids(db) == {"p2", "p3", "c2", "c3"}


def test_a_different_blurb_is_a_different_chunk(kdb) -> None:  # type: ignore[no-untyped-def]
    with sessions().begin() as db:
        db.execute(
            text(
                "INSERT INTO knowledge.sources (id, workspace_id, kind, title, status, progress, "
                "tags, topics, "
                "current_version) VALUES (:id, 'ws', 'text', 'T', 'ready', '{}', '{}', '{}', 2)"
            ),
            {"id": SID},
        )
        for v in (1, 2):
            chunk(db, f"p{v}", v, 0, f"P{v}")
        chunk(db, "c1", 1, 1, "Same words.", "p1", "From the intro")
        chunk(db, "c2", 2, 1, "Same words.", "p2", "From the appendix")
    assert tidy.tidy()["chunks_removed"] == 0


def test_a_dry_run_counts_and_changes_nothing(seeded) -> None:  # type: ignore[no-untyped-def]
    with sessions()() as db:
        before = ids(db)
    out = tidy.tidy(dry_run=True)
    assert out["dry_run"] is True and out["chunks_removed"] == 3 and out["parents_removed"] == 1
    with sessions()() as db:
        assert ids(db) == before


def test_waits_while_sources_are_being_read_and_changes_nothing(seeded) -> None:  # type: ignore[no-untyped-def]
    with sessions().begin() as db:
        db.execute(
            text(
                "INSERT INTO knowledge.sources (id, workspace_id, kind, title, status, progress, "
                "tags, topics) "
                "VALUES ('src_busy', 'ws', 'text', 'Reading', 'embedding', '{}', '{}', '{}')"
            )
        )
        before = ids(db)
    from ancile_knowledge.errors import AncileError

    with pytest.raises(AncileError) as e:
        tidy.tidy()
    assert e.value.code == "maintenance.busy"
    with sessions()() as db:
        assert ids(db) == before


def test_the_route_needs_the_service_token_and_answers(seeded) -> None:  # type: ignore[no-untyped-def]
    with TestClient(create_app()) as c:
        assert c.post("/kn/v1/maintenance/tidy", json={}).status_code == 401
        r = c.post("/kn/v1/maintenance/tidy", json={"dry_run": True}, headers=AUTH)
        assert r.status_code == 200 and r.json()["chunks_removed"] == 3


def test_identical_old_version_bodies_become_one_file(kdb) -> None:  # type: ignore[no-untyped-def]
    with sessions().begin() as db:
        db.execute(
            text(
                "INSERT INTO knowledge.sources (id, workspace_id, kind, title, status, progress, "
                "tags, topics, "
                "current_version) VALUES (:id, 'ws', 'text', 'T', 'ready', '{}', '{}', '{}', 3)"
            ),
            {"id": SID},
        )
        for v, h, body in (
            (1, "h1", "Same page body.\n"),
            (2, "h1", "Same page body.\n"),
            (3, "h3", "A new body.\n"),
        ):
            repo.write_atomic(repo.markdown_path(SID, v), body)
            db.execute(
                text(
                    "INSERT INTO knowledge.source_versions "
                    "(source_id, version, markdown_path, extractor, content_hash) "
                    "VALUES (:s, :v, :p, 'text', :h)"
                ),
                {"s": SID, "v": v, "p": str(repo.markdown_path(SID, v)), "h": h},
            )
        # A claimed-identical pair whose bytes differ must not be merged (the bytes decide).
        repo.write_atomic(repo.markdown_path(SID, 4), "Different bytes.\n")
    out = tidy.tidy()
    assert out["bodies_linked"] == 1 and out["bodies_bytes"] == len("Same page body.\n")
    v1, v2, v3 = (repo.markdown_path(SID, v) for v in (1, 2, 3))
    assert os.path.samefile(v1, v2) and not os.path.samefile(v1, v3)
    # Readers still find every version at its own path.
    assert repo.read_markdown(v2) == "Same page body.\n" and repo.read_markdown(v3) == "A new body.\n"
    # Rewriting one name later does not change the other.
    repo.write_atomic(v2, "Rewritten.\n")
    assert repo.read_markdown(v1) == "Same page body.\n"
    assert tidy.tidy()["bodies_linked"] == 0
