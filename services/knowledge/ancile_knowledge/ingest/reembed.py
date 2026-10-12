"""
------------------------------------------------------------------
 Title    |  Re-embedding in the background when the model changes
 Ref      |  alembic 0004_embed_index · docs/configuration.md (Changing the embedding model)
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Change the embedding model without a gap in search: the
          |  old model's vectors keep answering until every current
          |  passage has a vector from the new one, then search swaps
          |  to it in one step.
 How      |  knowledge.embed_index holds the active model (what search
          |  reads) and, during a re-embed, the target (the configured
          |  model). The worker calls
          |    check()  at start and every minute: an active model is
          |             adopted on first run (the one with most
          |             vectors, else the configured one); a configured
          |             model that differs starts a re-embed
          |    step()   when no source is waiting: one batch of current
          |             passages without a target vector is embedded;
          |             when none is left the active model becomes the
          |             target and the old vectors are deleted
          |  Progress (done of total) is recounted from the database
          |  after every batch, so a restart resumes where it stopped.
          |  New sources ingested meanwhile are embedded with both
          |  models (pipeline.stage_embedding), so they are found
          |  before and after the swap.
 Note     |  Search embeds the query with the active model, loaded
          |  from the local cache (embed.embedder_for_key). If it
          |  cannot be loaded, search degrades to text, as without
          |  any embedder.
------------------------------------------------------------------
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import sessions
from ..errors import AncileError
from ..obs import get_logger
from ..settings import get_settings
from . import embed as embed_mod

log = get_logger("reembed")

S = "knowledge"
ACTIVE_TTL_S = 5.0

# Current passages: the ready version of a live source, children only (parents are never embedded).
_CURRENT = (
    f"FROM {S}.chunks c JOIN {S}.sources s ON s.id = c.source_id "
    f"WHERE s.deleted_at IS NULL AND c.version = s.current_version AND c.parent_id IS NOT NULL"
)

_cache_lock = threading.Lock()
_active: tuple[float, str | None] | None = None


def _forget_active() -> None:
    global _active
    with _cache_lock:
        _active = None


def active_model_key() -> str | None:
    """The model whose vectors search reads; cached for a few seconds."""
    global _active
    now = time.monotonic()
    with _cache_lock:
        if _active is not None and now - _active[0] < ACTIVE_TTL_S:
            return _active[1]
    with sessions().begin() as db:
        raw = db.execute(text(f"SELECT active_model_key FROM {S}.embed_index WHERE id = 1")).scalar()
    key = str(raw) if raw is not None else None
    with _cache_lock:
        _active = (now, key)
    return key


def search_embedder() -> embed_mod.Embedder | None:
    """The embedder for queries: the active model's, else (nothing adopted yet) the configured one."""
    key = active_model_key()
    if key is None:
        return embed_mod.try_get_embedder(download=False)
    return embed_mod.embedder_for_key(key)


def extra_ingest_embedders(configured: embed_mod.Embedder) -> list[embed_mod.Embedder]:
    """During a re-embed, new sources also get the active model's vectors, so search finds them now."""
    key = active_model_key()
    if key is None or key == configured.model_key:
        return []
    old = embed_mod.embedder_for_key(key)
    return [old] if old is not None else []


def _iso(v: datetime | None) -> str | None:
    return v.isoformat() if v else None


def status() -> dict[str, Any]:
    """GET /embeddings: the active and configured models, and the re-embed's progress."""
    configured = embed_mod.try_get_embedder(download=False)
    with sessions().begin() as db:
        row = db.execute(text(f"SELECT * FROM {S}.embed_index WHERE id = 1")).mappings().first()
    r = dict(row) if row else {}
    total, done = int(r.get("total") or 0), int(r.get("done") or 0)
    return {
        "active_model_key": r.get("active_model_key"),
        "configured_model_key": configured.model_key if configured else None,
        "reembed": {
            "status": r.get("status", "idle"),
            "target_model_key": r.get("target_model_key"),
            "total": total,
            "done": done,
            "percent": round(100 * done / total) if total else (100 if r.get("status") == "idle" else 0),
            "error": r.get("error"),
            "started_at": _iso(r.get("started_at")),
            "finished_at": _iso(r.get("finished_at")),
            "updated_at": _iso(r.get("updated_at")),
        },
    }


def _counts(db: Session, model_key: str) -> tuple[int, int]:
    """(current passages, those with a vector from model_key)."""
    total = db.execute(text(f"SELECT count(*) {_CURRENT}")).scalar_one()
    done = db.execute(
        text(
            f"SELECT count(*) {_CURRENT} AND EXISTS ("
            f"  SELECT 1 FROM {S}.chunk_embeddings e WHERE e.chunk_id = c.id AND e.model_key = :mk)"
        ),
        {"mk": model_key},
    ).scalar_one()
    return int(total), int(done)


def check(*, download: bool = True) -> dict[str, Any]:
    """Adopt an active model, and start (or cancel) a re-embed when the configured one differs."""
    configured = embed_mod.try_get_embedder(download=download)
    with sessions().begin() as db:
        row = db.execute(text(f"SELECT * FROM {S}.embed_index WHERE id = 1 FOR UPDATE")).mappings().first()
        if row is None:  # the migration seeds it; recreate if someone removed it
            db.execute(text(f"INSERT INTO {S}.embed_index (id) VALUES (1) ON CONFLICT (id) DO NOTHING"))
            row = db.execute(text(f"SELECT * FROM {S}.embed_index WHERE id = 1 FOR UPDATE")).mappings().one()
        active = row["active_model_key"]
        if active is None:
            # First run: keep whatever vectors exist, so an upgrade never goes blind.
            most = db.execute(
                text(
                    f"SELECT model_key FROM {S}.chunk_embeddings GROUP BY model_key "
                    f"ORDER BY count(*) DESC, model_key LIMIT 1"
                )
            ).scalar()
            active = most or (configured.model_key if configured else None)
            if active is not None:
                db.execute(
                    text(
                        f"UPDATE {S}.embed_index SET active_model_key = :a, updated_at = now() WHERE id = 1"
                    ),
                    {"a": active},
                )
                log.info("embedding model adopted", model=active)
        if configured is None:
            pass  # nothing to move to; search keeps the active model
        elif configured.model_key == active:
            if row["status"] != "idle":
                db.execute(
                    text(
                        f"UPDATE {S}.embed_index SET status = 'idle', target_model_key = NULL, error = NULL, "
                        f"updated_at = now() WHERE id = 1"
                    )
                )
                log.info("re-embed cancelled: the configured model is the active one", model=active)
        elif row["status"] != "running" or row["target_model_key"] != configured.model_key:
            total, done = _counts(db, configured.model_key)
            db.execute(
                text(
                    f"UPDATE {S}.embed_index SET target_model_key = :t, status = 'running', total = :total, "
                    f"done = :done, error = NULL, started_at = now(), finished_at = NULL, updated_at = now() "
                    f"WHERE id = 1"
                ),
                {"t": configured.model_key, "total": total, "done": done},
            )
            log.info("re-embed started", source_model=active, target_model=configured.model_key, total=total)
    _forget_active()
    return status()


def _fail(err: AncileError) -> None:
    stored = {"code": err.code, "title": err.title, "hint": err.hint}
    with sessions().begin() as db:
        db.execute(
            text(
                f"UPDATE {S}.embed_index SET status = 'failed', error = CAST(:e AS jsonb), "
                f"updated_at = now() WHERE id = 1"
            ),
            {"e": json.dumps(stored)},
        )
    log.warning("re-embed failed", code=err.code)


def _swap(target: str) -> None:
    """Every current passage has a target vector: search moves to it, and the old vectors go."""
    with sessions().begin() as db:
        old = db.execute(
            text(f"SELECT active_model_key FROM {S}.embed_index WHERE id = 1 FOR UPDATE")
        ).scalar()
        db.execute(
            text(
                f"UPDATE {S}.embed_index SET active_model_key = :t, target_model_key = NULL, "
                f"status = 'idle', done = total, finished_at = now(), updated_at = now() WHERE id = 1"
            ),
            {"t": target},
        )
    _forget_active()
    log.info("re-embed finished: search now uses the new model", source_model=old, target_model=target)
    if old and old != target:
        with sessions().begin() as db:
            n = db.execute(
                text(f"DELETE FROM {S}.chunk_embeddings WHERE model_key = :old"), {"old": old}
            ).rowcount
        log.info("old vectors removed", model=old, count=n)


def step(batch: int | None = None) -> bool:
    """Embed one batch for a running re-embed. True when there may be more to do."""
    with sessions().begin() as db:
        row = (
            db.execute(text(f"SELECT status, target_model_key FROM {S}.embed_index WHERE id = 1"))
            .mappings()
            .first()
        )
    if row is None or row["status"] != "running" or not row["target_model_key"]:
        return False
    target = str(row["target_model_key"])
    try:
        embedder = embed_mod.get_embedder(download=True)
    except AncileError as err:
        _fail(err)
        return False
    if embedder.model_key != target:
        check(download=False)  # the configuration moved on: start again towards the new one
        return True
    from .enrich import embedding_text
    from .pipeline import ensure_vector_index, vec_literal

    ensure_vector_index(embedder.model_key, embedder.dim)
    n = batch or get_settings().embed_batch
    with sessions().begin() as db:
        todo = db.execute(
            text(
                f"SELECT c.id, c.context_blurb, c.text {_CURRENT} AND NOT EXISTS ("
                f"  SELECT 1 FROM {S}.chunk_embeddings e WHERE e.chunk_id = c.id AND e.model_key = :mk) "
                f"ORDER BY c.id LIMIT :n"
            ),
            {"mk": target, "n": n},
        ).all()
    if not todo:
        _swap(target)
        return False
    try:
        vectors = embedder.embed([embedding_text(b, t) for _, b, t in todo])
    except AncileError as err:
        _fail(err)
        return False
    with sessions().begin() as db:
        db.execute(
            text(
                f"INSERT INTO {S}.chunk_embeddings (chunk_id, model_key, embedding) "
                f"VALUES (:cid, :mk, CAST(:vec AS vector)) ON CONFLICT DO NOTHING"
            ),
            [
                {"cid": cid, "mk": target, "vec": vec_literal(vec)}
                for (cid, _, _), vec in zip(todo, vectors, strict=True)
            ],
        )
        total, done = _counts(db, target)
        db.execute(
            text(
                f"UPDATE {S}.embed_index SET total = :total, done = :done, updated_at = now() "
                f"WHERE id = 1 AND status = 'running' AND target_model_key = :t"
            ),
            {"total": total, "done": done, "t": target},
        )
    log.info("re-embed progress", target_model=target, done=done, total=total)
    return True


def reset_index() -> None:
    """Forget the active model and any re-embed (tests and evals on a throwaway database only)."""
    with sessions().begin() as db:
        db.execute(
            text(
                f"UPDATE {S}.embed_index SET active_model_key = NULL, target_model_key = NULL, "
                f"status = 'idle', total = 0, done = 0, error = NULL, started_at = NULL, "
                f"finished_at = NULL, updated_at = now() WHERE id = 1"
            )
        )
    _forget_active()


def run(limit: int = 1_000_000) -> int:
    """Run a re-embed to the end in this thread (tests, evals, the CLI). Returns the batches done."""
    n = 0
    while n < limit and step():
        n += 1
    return n
