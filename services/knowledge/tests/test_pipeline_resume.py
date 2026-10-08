"""
A stage that crashes mid-way resumes at that stage with no duplicate chunks or
embeddings (ROADMAP Phase 3). "Crash" here is a BaseException the worker does
not catch, standing in for the process dying: the lease stays, nothing is
cleaned up, and recovery has to cope.
"""

from __future__ import annotations

import asyncio
import json
import time

import pytest
from sqlalchemy import text

from ancile_knowledge import jobs
from ancile_knowledge.ingest import embed, pipeline
from ancile_knowledge.ingest.chunk import chunk_markdown
from ancile_knowledge.settings import get_settings
from ancile_knowledge.sources import repo

pytestmark = pytest.mark.usefixtures("kdb")


class Crash(BaseException):
    pass


DOC = "# Field notes\n\n" + "\n\n".join(
    f"## Site {i}\n\nObservation {i}: the heron waded at dawn near reed bed {i}, "
    f"and the water temperature was {10 + i} degrees. Notes continue with detail {i * 7}."
    for i in range(40)
)


def _add_text(ws: str = "ws1", body: str = DOC, title: str = "Field notes") -> str:
    sid = repo.new_id()
    repo.write_atomic(repo.input_path(sid), body)
    with repo_session() as db:
        db.execute(
            text(
                "INSERT INTO knowledge.sources "
                "(id, workspace_id, kind, title, status, progress, tags, topics) "
                "VALUES (:id, :ws, 'text', :t, 'queued', '{}', '{}', '{}')"
            ),
            {"id": sid, "ws": ws, "t": title},
        )
    return sid


def repo_session():  # type: ignore[no-untyped-def]
    from ancile_knowledge.db import sessions

    return sessions().begin()


def _counts(sid: str) -> dict[str, int]:
    with repo_session() as db:
        r = (
            db.execute(
                text(
                    "SELECT (SELECT count(*) FROM knowledge.chunks WHERE source_id = :id) AS chunks, "
                    "(SELECT count(DISTINCT (version, ordinal)) FROM knowledge.chunks "
                    "  WHERE source_id = :id) AS uniq, "
                    "(SELECT count(*) FROM knowledge.chunks "
                    "  WHERE source_id = :id AND parent_id IS NOT NULL) AS kids, "
                    "(SELECT count(*) FROM knowledge.chunk_embeddings e JOIN knowledge.chunks c "
                    "   ON c.id = e.chunk_id WHERE c.source_id = :id) AS embs, "
                    "(SELECT count(*) FROM knowledge.insights WHERE source_id = :id) AS insights"
                ),
                {"id": sid},
            )
            .mappings()
            .one()
        )
    return dict(r)


def _status(sid: str) -> dict[str, object]:
    with repo_session() as db:
        return dict(
            db.execute(
                text(
                    "SELECT status, lease_owner, current_version, pending_version, error "
                    "FROM knowledge.sources "
                    "WHERE id = :id"
                ),
                {"id": sid},
            )
            .mappings()
            .one()
        )


def _expected_children() -> int:
    return len(chunk_markdown(DOC, pipeline.chunk_config()).children)


class CrashingEmbedder:
    def __init__(self, after_batches: int) -> None:
        self.inner = embed.HashEmbedder()
        self.model_key, self.dim = self.inner.model_key, self.inner.dim
        self.calls = 0
        self.after = after_batches

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls += 1
        if self.calls > self.after:
            raise Crash("process died while embedding")
        return self.inner.embed(texts)


def _run_until_crash(worker: str) -> None:
    claimed = jobs.claim(worker)
    assert claimed is not None
    with pytest.raises(Crash):
        asyncio.run(jobs.process(claimed, worker))


def test_crash_mid_embedding_resumes_without_duplicates(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "embed_batch", 8)
    sid = _add_text()
    crashing = CrashingEmbedder(after_batches=2)
    embed.set_embedder(crashing)
    _run_until_crash("w-dead")

    st = _status(sid)
    assert st["status"] == "embedding" and st["lease_owner"] == "w-dead"
    partial = _counts(sid)
    assert partial["embs"] == 16  # two batches committed before the crash

    # Restart: the previous process's lease is released, and the stage resumes.
    assert jobs.recover_leases() == 1
    embed.set_embedder(embed.HashEmbedder())
    asyncio.run(jobs.drain("w-new"))

    st = _status(sid)
    assert st["status"] == "ready" and st["current_version"] == 1 and st["pending_version"] is None
    c = _counts(sid)
    assert c["kids"] == _expected_children()
    assert c["chunks"] == c["uniq"]
    assert c["embs"] == c["kids"]  # exactly one vector per child chunk
    assert c["insights"] == 1


def test_rerunning_enrichment_replaces_rather_than_duplicates() -> None:
    sid = _add_text()
    asyncio.run(jobs.drain())
    first = _counts(sid)
    # Pretend the process died right after enrichment committed, then re-run it.
    with repo_session() as db:
        db.execute(
            text(
                "UPDATE knowledge.sources SET status = 'enriching', pending_version = current_version "
                "WHERE id = :id"
            ),
            {"id": sid},
        )
    asyncio.run(jobs.drain())
    again = _counts(sid)
    assert _status(sid)["status"] == "ready"
    assert again == first


def test_crash_mid_extraction_resumes(monkeypatch: pytest.MonkeyPatch) -> None:
    sid = _add_text()
    original = pipeline.stage_enriching

    def dying(row, report):  # type: ignore[no-untyped-def]
        raise Crash("died at the start of enrichment")

    monkeypatch.setattr(pipeline, "stage_enriching", dying)
    _run_until_crash("w-1")
    assert _status(sid)["status"] == "enriching"
    monkeypatch.setattr(pipeline, "stage_enriching", original)
    jobs.recover_leases()
    asyncio.run(jobs.drain())
    assert _status(sid)["status"] == "ready"
    assert _counts(sid)["kids"] == _expected_children()


def test_a_stage_that_crashes_twice_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    sid = _add_text()

    def boom(row, report):  # type: ignore[no-untyped-def]
        raise RuntimeError("extractor bug")

    monkeypatch.setattr(pipeline, "stage_enriching", boom)
    asyncio.run(jobs.drain())  # first crash: released with a backoff
    st = _status(sid)
    assert st["status"] == "enriching" and st["error"] is None
    with repo_session() as db:  # skip the backoff
        db.execute(text("UPDATE knowledge.sources SET lease_until = NULL WHERE id = :id"), {"id": sid})
    asyncio.run(jobs.drain())
    st = _status(sid)
    assert st["status"] == "failed"
    err = st["error"]
    assert isinstance(err, dict) and err["code"] == "ingest.crashed" and err["stage"] == "enriching"


def test_permanent_errors_fail_with_hint() -> None:
    sid = _add_text(body="   \n\n  ")
    asyncio.run(jobs.drain())
    st = _status(sid)
    assert st["status"] == "failed"
    err = st["error"]
    assert isinstance(err, dict) and err["code"] == "extract.empty" and err["hint"]


def test_worker_thread_resumes_stuck_sources_at_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "embed_batch", 8)
    sid = _add_text()
    crashing = CrashingEmbedder(after_batches=1)
    embed.set_embedder(crashing)
    _run_until_crash("w-previous-process")
    embed.set_embedder(embed.HashEmbedder())

    events: list[dict[str, object]] = []
    real_publish = pipeline.publish

    def spy(db, event):  # type: ignore[no-untyped-def]
        events.append(event)
        real_publish(db, event)

    monkeypatch.setattr(pipeline, "publish", spy)
    worker = jobs.Worker()
    worker.start()
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and _status(sid)["status"] != "ready":
            time.sleep(0.1)
    finally:
        worker.stop()
    assert _status(sid)["status"] == "ready"
    assert any(e["status"] == "ready" for e in events)
    assert all(len(json.dumps(e)) < 8000 for e in events)
    assert _counts(sid)["embs"] == _counts(sid)["kids"]
