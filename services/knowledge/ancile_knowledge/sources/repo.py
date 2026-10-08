"""
------------------------------------------------------------------
 Title    |  Sources repository
 Ref      |  packages/contracts/src/knowledge.ts (Source)
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  The SQL every sources endpoint shares: read a source with
          |  its derived fields, and turn a row into the Source shape
          |  the contract defines (field names exactly as in Zod).
 How      |  One SELECT with correlated subqueries for the counts,
          |  summary and open duplicate suggestion, so a list is one
          |  round trip. Paths for stored files live here too, so the
          |  layout under KNOWLEDGE_DATA_DIR is defined in one place.
 Note     |  Stored error JSON carries the failed stage and detail for
          |  retry and the logs; the API returns only code/title/hint.
------------------------------------------------------------------
"""

from __future__ import annotations

import os
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..errors import AncileError
from ..settings import get_settings

S = "knowledge"
ACTIVE = ("queued", "extracting", "enriching", "embedding")

SOURCE_COLUMNS = f"""
  s.id, s.workspace_id, s.kind, s.title, s.uri, s.mime, s.bytes, s.status, s.progress, s.error,
  s.tags, s.stale, s.fetched_at, s.created_at, s.updated_at, s.current_version, s.pending_version,
  s.deleted_at, s.content_hash, s.etag, s.last_modified, s.title_auto, s.topics, s.attempts,
  (SELECT count(*) FROM {S}.chunks c
     WHERE c.source_id = s.id AND c.version = s.current_version AND c.parent_id IS NOT NULL) AS chunk_count,
  (SELECT jsonb_array_length(v.pages) FROM {S}.source_versions v
     WHERE v.source_id = s.id AND v.version = s.current_version) AS page_count,
  (SELECT i.content_md FROM {S}.insights i
     WHERE i.source_id = s.id AND i.transformation_id = 'summary'
     ORDER BY i.created_at DESC LIMIT 1) AS summary,
  (SELECT jsonb_build_object('source_id', o.id, 'title', o.title, 'kind', r.kind, 'score', r.score)
     FROM {S}.source_relations r JOIN {S}.sources o ON o.id = r.b_id AND o.deleted_at IS NULL
     WHERE r.a_id = s.id AND r.status = 'suggested'
     ORDER BY (r.kind = 'duplicate') DESC, r.score DESC, o.id LIMIT 1) AS duplicate_of
"""


def new_id() -> str:
    return f"src_{uuid.uuid4().hex}"


def not_found(what: str = "source") -> AncileError:
    return AncileError(
        "request.not_found",
        f"That {what} does not exist",
        "It may have been deleted. Refresh the list.",
        status=404,
        error_class="permanent",
    )


# --- storage layout -----------------------------------------------------------------


def source_dir(source_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", source_id):
        raise not_found()
    return get_settings().storage_dir / "sources" / source_id


def markdown_path(source_id: str, version: int) -> Path:
    return source_dir(source_id) / f"v{version}.md"


def input_path(source_id: str) -> Path:
    """Pasted text and thread transcripts, kept so a retry can re-extract."""
    return source_dir(source_id) / "input.md"


def original_dir(source_id: str) -> Path:
    return source_dir(source_id) / "original"


def safe_filename(name: str | None) -> str:
    base = Path((name or "").replace("\\", "/")).name
    base = re.sub(r"[^\w.\- ()+]", "_", base).strip(" .") or "upload"
    return base[:180]


def write_atomic(path: Path, data: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(data, encoding="utf-8", newline="")
    os.replace(tmp, path)


def read_markdown(path: Path) -> str:
    # newline="" keeps the text byte-for-byte, so stored offsets stay exact.
    with open(path, encoding="utf-8", newline="") as fh:
        return fh.read()


# --- reads --------------------------------------------------------------------------


def fetch_sources(
    db: Session,
    *,
    ids: list[str] | None = None,
    workspace_id: str | None = None,
    include_deleted: bool = False,
) -> list[dict[str, Any]]:
    where = []
    params: dict[str, Any] = {}
    if ids is not None:
        where.append("s.id = ANY(:ids)")
        params["ids"] = ids
    if workspace_id is not None:
        where.append("s.workspace_id = :ws")
        params["ws"] = workspace_id
    if not include_deleted:
        where.append("s.deleted_at IS NULL")
    sql = f"SELECT {SOURCE_COLUMNS} FROM {S}.sources s"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY s.created_at DESC, s.id"
    return [dict(r._mapping) for r in db.execute(text(sql), params)]


def get_source_row(db: Session, source_id: str, workspace_id: str | None = None) -> dict[str, Any]:
    rows = fetch_sources(db, ids=[source_id], workspace_id=workspace_id)
    if not rows:
        raise not_found()
    return rows[0]


def _iso(v: datetime | None) -> str | None:
    return v.isoformat() if v else None


def serialize(row: dict[str, Any], context_level: str | None = None) -> dict[str, Any]:
    progress = row.get("progress") or None
    if progress:
        progress = {
            "stage": progress.get("stage", row["status"]),
            "message": progress.get("message", ""),
            "done": progress.get("done"),
            "total": progress.get("total"),
        }
    err = row.get("error")
    error = {"code": err["code"], "title": err["title"], "hint": err["hint"]} if err else None
    dup = row.get("duplicate_of")
    out: dict[str, Any] = {
        "id": row["id"],
        "kind": row["kind"],
        "title": row["title"],
        "uri": row["uri"],
        "mime": row["mime"],
        "bytes": row["bytes"],
        "status": row["status"],
        "progress": progress,
        "error": error,
        "tags": list(row.get("tags") or []),
        "summary": row.get("summary"),
        "chunks": int(row.get("chunk_count") or 0),
        "pages": int(row["page_count"]) if row.get("page_count") else None,
        "stale": bool(row.get("stale")),
        "fetched_at": _iso(row.get("fetched_at")),
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
        "duplicate_of": (
            {
                "source_id": dup["source_id"],
                "title": dup["title"],
                "kind": dup["kind"],
                "score": round(float(dup["score"]), 4),
            }
            if dup
            else None
        ),
    }
    if context_level is not None:
        out["context_level"] = context_level
    return out
