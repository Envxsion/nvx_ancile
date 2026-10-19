"""
------------------------------------------------------------------
 Title    |  Tidy storage: duplicate chunks and old version bodies
 Ref      |  ROADMAP.md MT1 · docs/storage.md
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Take back space that pile-up wastes, without changing
          |  anything a person can see or search: chunks of old
          |  versions that say what a newer chunk already says, and
          |  stored copies of an old version's text that are the same
          |  bytes as another version's.
 How      |  POST /kn/v1/maintenance/tidy {dry_run}. Chunks: for each
          |  source, a chunk of a superseded version is removed when a
          |  chunk with the same content hash (its text with white
          |  space collapsed, plus its context blurb) exists in the
          |  current version, or in a newer superseded one. Search and
          |  passage checks read the current version only, and a
          |  citation keeps its own quote and hash, so nothing a
          |  person reads depends on a removed chunk. A parent chunk
          |  goes only when none of its children is left. Bodies: v{N}.md
          |  files with the same content hash (checked again by reading
          |  both) become one file with two names (a hard link), so every
          |  reader still finds its path. Embeddings follow their chunks
          |  (ON DELETE CASCADE).
 Note     |  Refuses while sources are being read or a re-embed runs
          |  (maintenance.busy): Core also refuses during a run, takes
          |  a backup and checks disk space first, then vacuums. The
          |  current version and a pending one are never touched.
          |  Idea from Octop (MIT); the code is ours.
------------------------------------------------------------------
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import sessions
from ..errors import AncileError
from ..obs import get_logger
from . import repo
from .repo import S

log = get_logger("tidy")
router = APIRouter()

_WS = re.compile(r"\s+")
BATCH = 500
BUSY_STATUSES = ("queued", "extracting", "enriching", "embedding")


def chunk_hash(body: str, blurb: str | None) -> str:
    """Content hash of a chunk: its text with white space collapsed, and its context blurb."""
    norm = _WS.sub(" ", body).strip()
    return hashlib.sha256(f"{norm}\x00{blurb or ''}".encode()).hexdigest()


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def busy_reason(db: Session) -> str | None:
    """Why tidying must wait, or None."""
    n = db.execute(
        text(f"SELECT count(*) FROM {S}.sources WHERE deleted_at IS NULL AND status = ANY(:s)"),
        {"s": list(BUSY_STATUSES)},
    ).scalar_one()
    if n:
        return f"{n} {'source is' if n == 1 else 'sources are'} still being read"
    running = db.execute(text(f"SELECT 1 FROM {S}.embed_index WHERE status = 'running' LIMIT 1")).first()
    if running:
        return "the embedding model is being changed"
    return None


def _superseded_chunks(db: Session, source_id: str, current: int, pending: int | None) -> list[Any]:
    """Child chunks of superseded versions, newest version first."""
    return list(
        db.execute(
            text(
                f"SELECT id, version, text, context_blurb FROM {S}.chunks "
                f"WHERE source_id = :s AND parent_id IS NOT NULL AND version < :cur "
                f"AND (CAST(:pend AS int) IS NULL OR version <> :pend) "
                f"ORDER BY version DESC, ordinal"
            ),
            {"s": source_id, "cur": current, "pend": pending},
        ).mappings()
    )


def duplicate_chunk_ids(
    db: Session, source_id: str, current: int, pending: int | None
) -> tuple[list[str], int]:
    """Ids of superseded child chunks whose content already exists in a newer version, and their text size."""
    seen = {
        chunk_hash(r["text"], r["context_blurb"])
        for r in db.execute(
            text(
                f"SELECT text, context_blurb FROM {S}.chunks "
                f"WHERE source_id = :s AND version = :cur AND parent_id IS NOT NULL"
            ),
            {"s": source_id, "cur": current},
        ).mappings()
    }
    dup: list[str] = []
    size = 0
    for r in _superseded_chunks(db, source_id, current, pending):
        h = chunk_hash(r["text"], r["context_blurb"])
        if h in seen:
            dup.append(r["id"])
            size += len(r["text"])
        else:
            seen.add(h)
    return dup, size


def _tidy_chunks(dry_run: bool) -> dict[str, int]:
    removed = parents = size = touched = 0
    with sessions()() as db:
        rows = list(
            db.execute(
                text(
                    f"SELECT s.id, s.current_version, s.pending_version FROM {S}.sources s "
                    f"WHERE s.current_version > 1 AND EXISTS "
                    f"(SELECT 1 FROM {S}.chunks c WHERE c.source_id = s.id AND c.version < s.current_version)"
                )
            ).mappings()
        )
    for row in rows:
        with sessions().begin() as db:
            dup, nbytes = duplicate_chunk_ids(db, row["id"], row["current_version"], row["pending_version"])
            orphan_parents = 0
            if not dry_run:
                for i in range(0, len(dup), BATCH):
                    db.execute(
                        text(f"DELETE FROM {S}.chunks WHERE id = ANY(:ids)"), {"ids": dup[i : i + BATCH]}
                    )
                orphan_parents = db.execute(
                    text(
                        f"DELETE FROM {S}.chunks p WHERE p.source_id = :s AND p.parent_id IS NULL "
                        f"AND p.version < :cur AND (CAST(:pend AS int) IS NULL OR p.version <> :pend) "
                        f"AND NOT EXISTS (SELECT 1 FROM {S}.chunks c WHERE c.parent_id = p.id)"
                    ),
                    {"s": row["id"], "cur": row["current_version"], "pend": row["pending_version"]},
                ).rowcount
            else:
                orphan_parents = db.execute(
                    text(
                        f"SELECT count(*) FROM {S}.chunks p WHERE p.source_id = :s AND p.parent_id IS NULL "
                        f"AND p.version < :cur AND (CAST(:pend AS int) IS NULL OR p.version <> :pend) "
                        f"AND NOT EXISTS (SELECT 1 FROM {S}.chunks c WHERE c.parent_id = p.id "
                        f"AND NOT (c.id = ANY(CAST(:dup AS text[]))))"
                    ),
                    {
                        "s": row["id"],
                        "cur": row["current_version"],
                        "pend": row["pending_version"],
                        "dup": dup,
                    },
                ).scalar_one()
        if dup or orphan_parents:
            touched += 1
        removed += len(dup)
        parents += int(orphan_parents)
        size += nbytes
    return {
        "chunks_removed": removed,
        "parents_removed": parents,
        "chunk_text_bytes": size,
        "chunk_sources": touched,
    }


def _link_bodies(dry_run: bool) -> dict[str, int]:
    linked = saved = skipped = 0
    with sessions()() as db:
        groups = list(
            db.execute(
                text(
                    f"SELECT v.source_id, v.content_hash, "
                    f"array_agg(v.version ORDER BY v.version) AS versions, "
                    f"max(s.pending_version) AS pending FROM {S}.source_versions v "
                    f"JOIN {S}.sources s ON s.id = v.source_id "
                    f"GROUP BY v.source_id, v.content_hash HAVING count(*) > 1"
                )
            ).mappings()
        )
    for g in groups:
        files = [(v, repo.markdown_path(g["source_id"], v)) for v in g["versions"] if v != g["pending"]]
        files = [(v, p) for v, p in files if p.is_file()]
        if len(files) < 2:
            continue
        canon = files[0][1]
        try:
            digest = file_sha256(canon)
        except OSError:
            skipped += 1
            continue
        for _, other in files[1:]:
            try:
                if os.path.samefile(canon, other):
                    continue
                # The database's hash is a hint; the bytes decide.
                if other.stat().st_size != canon.stat().st_size or file_sha256(other) != digest:
                    continue
                size = other.stat().st_size
                if not dry_run:
                    tmp = other.with_name(other.name + ".tidy")
                    try:
                        os.link(canon, tmp)
                        os.replace(tmp, other)
                    finally:
                        if tmp.exists():
                            tmp.unlink()
                linked += 1
                saved += size
            except OSError:
                # No hard links here (another volume, a file system without them): leave the copy.
                skipped += 1
    return {"bodies_linked": linked, "bodies_bytes": saved, "bodies_skipped": skipped}


def tidy(dry_run: bool = False) -> dict[str, Any]:
    """Remove duplicate chunks and link identical version bodies; maintenance.busy while sources are read."""
    with sessions()() as db:
        reason = busy_reason(db)
    if reason:
        raise AncileError(
            "maintenance.busy",
            "Storage can't be tidied while sources are being read",
            f"Wait until {reason}, then try again. Nothing was changed.",
            status=409,
            error_class="transient",
            retryable=True,
        )
    out: dict[str, Any] = {"dry_run": dry_run, **_tidy_chunks(dry_run), **_link_bodies(dry_run)}
    log.info("storage tidied" if not dry_run else "storage tidy previewed", **out)
    return out


class TidyBody(BaseModel):
    dry_run: bool = False


@router.post("/maintenance/tidy")
def tidy_route(body: TidyBody | None = None) -> dict[str, Any]:
    """Dedupe chunks and identical old version bodies by content hash (ROADMAP MT1)."""
    return tidy((body or TidyBody()).dry_run)
