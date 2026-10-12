"""
------------------------------------------------------------------
 Title    |  Source integrity: cited passages and languages
 Ref      |  ROADMAP.md track G · packages/contracts/src/knowledge.ts
          |  (PassageCheckRequest, NotebookLanguages) · docs/sources.md
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  POST /passages/check  is each cited passage still what
          |                        it was: current, changed or removed?
          |  GET  /notebooks/{id}/languages  the languages of a
          |                        notebook's sources, and whether the
          |                        embedder reads them all well.
 How      |  A passage is current when its chunk (or insight) is still
          |  in the source's current version with the same sha256, or
          |  when re-reading the source moved the same text to a new
          |  chunk. A deleted source (deleted_at set, or no row at all)
          |  is removed. Without a hash (citations older than track G),
          |  being in the current version is enough.
 Note     |  Read-only. Hashes are of the passage text exactly as
          |  search returned it (chunks.text, insights.content_md),
          |  UTF-8, hex: the same bytes Core hashed when it cited.
------------------------------------------------------------------
"""

from __future__ import annotations

import hashlib
from typing import Annotated, Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import sessions
from ..settings import get_settings
from . import language
from .repo import S

router = APIRouter()

State = Literal["current", "changed", "removed"]

# The same expression in SQL, for "did this text move to another chunk?".
_SHA_SQL = "encode(sha256(convert_to({col}, 'UTF8')), 'hex')"


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class PassageRef(BaseModel):
    ref: str = Field(min_length=1, max_length=200)
    source_id: str = Field(min_length=1, max_length=200)
    text_sha256: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")] | None = None


class PassageCheckBody(BaseModel):
    workspace_id: str = Field(min_length=1, max_length=200)
    items: list[PassageRef] = Field(max_length=500)


def _moved(db: Session, source_id: str, version: int, digest: str) -> bool:
    """The same text is still in the source, under another chunk or insight id."""
    hit = db.execute(
        text(
            f"SELECT 1 FROM {S}.chunks c WHERE c.source_id = :s AND c.version = :v "
            f"AND {_SHA_SQL.format(col='c.text')} = :h "
            f"UNION ALL SELECT 1 FROM {S}.insights i WHERE i.source_id = :s "
            f"AND {_SHA_SQL.format(col='i.content_md')} = :h LIMIT 1"
        ),
        {"s": source_id, "v": version, "h": digest},
    ).first()
    return hit is not None


def check_passages(body: PassageCheckBody) -> list[dict[str, Any]]:
    source_ids = sorted({i.source_id for i in body.items})
    refs = sorted({i.ref for i in body.items})
    out: list[dict[str, Any]] = []
    with sessions().begin() as db:
        sources = {
            r["id"]: r
            for r in db.execute(
                text(
                    f"SELECT id, title, current_version, deleted_at FROM {S}.sources "
                    f"WHERE workspace_id = :ws AND id = ANY(:ids)"
                ),
                {"ws": body.workspace_id, "ids": source_ids},
            ).mappings()
        }
        chunks = {
            r["id"]: r
            for r in db.execute(
                text(f"SELECT id, source_id, version, text FROM {S}.chunks WHERE id = ANY(:ids)"),
                {"ids": refs},
            ).mappings()
        }
        insights = {
            r["id"]: r
            for r in db.execute(
                text(f"SELECT id, source_id, content_md FROM {S}.insights WHERE id = ANY(:ids)"),
                {"ids": refs},
            ).mappings()
        }
        for item in body.items:
            src = sources.get(item.source_id)
            state: State
            if src is None or src["deleted_at"] is not None:
                state = "removed"
            else:
                chunk = chunks.get(item.ref)
                ins = insights.get(item.ref)
                held: str | None = None  # the text under this id in the current version, if any
                if (
                    chunk is not None
                    and chunk["source_id"] == item.source_id
                    and chunk["version"] == src["current_version"]
                ):
                    held = chunk["text"]
                elif ins is not None and ins["source_id"] == item.source_id:
                    held = ins["content_md"]
                same = held is not None and (item.text_sha256 is None or sha256(held) == item.text_sha256)
                state = "current" if same else "changed"
                if (
                    state == "changed"
                    and item.text_sha256 is not None
                    and _moved(db, item.source_id, int(src["current_version"] or 0), item.text_sha256)
                ):
                    state = "current"
            out.append(
                {
                    "ref": item.ref,
                    "source_id": item.source_id,
                    "state": state,
                    "source_title": src["title"] if src is not None else None,
                    "deleted_at": (
                        src["deleted_at"].isoformat() if src is not None and src["deleted_at"] else None
                    ),
                }
            )
    return out


@router.post("/passages/check")
def passages_check(body: PassageCheckBody) -> dict[str, Any]:
    return {"items": check_passages(body)}


@router.get("/notebooks/{notebook_id}/languages")
def notebook_languages(notebook_id: str, workspace_id: str | None = None) -> dict[str, Any]:
    params: dict[str, Any] = {"nb": notebook_id}
    ws = ""
    if workspace_id is not None:
        ws = " AND s.workspace_id = :ws"
        params["ws"] = workspace_id
    with sessions().begin() as db:
        rows = db.execute(
            text(
                f"SELECT s.language, count(*) AS n FROM {S}.notebook_sources ns "
                f"JOIN {S}.sources s ON s.id = ns.source_id "
                f"WHERE ns.notebook_id = :nb AND ns.context_level <> 'off' AND s.deleted_at IS NULL "
                f"AND s.status = 'ready' AND s.language IS NOT NULL{ws} "
                f"GROUP BY s.language ORDER BY count(*) DESC, s.language"
            ),
            params,
        ).all()
    settings = get_settings()
    model = settings.embed_model
    multilingual = language.is_multilingual(model)
    return {
        "languages": [{"code": str(lang), "sources": int(n)} for lang, n in rows],
        "mixed": len(rows) > 1,
        "embedder": {"model": model, "multilingual": multilingual},
        "multilingual_option": None if multilingual else settings.multilingual_embed_model,
    }
