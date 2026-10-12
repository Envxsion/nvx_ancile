"""
------------------------------------------------------------------
 Title    |  The knowledge half of a notebook merge
 Ref      |  docs/notebooks.md (Merging notebooks) ·
          |  packages/contracts/src/notebooks.ts (KnMergePreview,
          |  KnMergeRecord)
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  When Core merges notebook B into notebook A, B's sources
          |  join A: linked once, never twice, and a copy of a source
          |  A already holds (same content hash) is merged into A's.
 How      |  preview: what would happen, changing nothing. merge: in
          |  one transaction, B's links move to A (A's context level
          |  wins where both had the source); each B source whose
          |  content hash matches one of A's is unlinked from B and,
          |  when no other notebook holds it, soft-deleted in favour
          |  of A's copy (Core writes the tombstone, so citations of
          |  it still resolve). Same address or title with different
          |  content is another version: both are kept. undo: puts
          |  every link back and brings merged copies back, from the
          |  record merge returned.
 Note     |  Core owns notebooks; this only moves links and marks
          |  sources, trusting Core for notebook existence.
------------------------------------------------------------------
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import text

from ..db import sessions
from .repo import S

router = APIRouter()


def _sources(db: Any, notebook_id: str, workspace_id: str | None) -> list[dict[str, Any]]:
    sql = (
        f"SELECT s.id, s.title, s.kind, s.uri, s.content_hash, ns.context_level "
        f"FROM {S}.notebook_sources ns JOIN {S}.sources s ON s.id = ns.source_id "
        f"WHERE ns.notebook_id = :nb AND s.deleted_at IS NULL"
    )
    params: dict[str, Any] = {"nb": notebook_id}
    if workspace_id is not None:
        sql += " AND s.workspace_id = :ws"
        params["ws"] = workspace_id
    return [dict(r._mapping) for r in db.execute(text(sql + " ORDER BY s.created_at, s.id"), params)]


def _plan(into: list[dict[str, Any]], frm: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    into_ids = {s["id"] for s in into}
    by_hash = {s["content_hash"]: s for s in into if s["content_hash"]}
    by_uri = {s["uri"]: s for s in into if s["uri"]}
    by_title = {(s["title"] or "").strip().lower(): s for s in into if s["title"]}
    plan: dict[str, list[dict[str, Any]]] = {"move": [], "already": [], "duplicates": [], "versions": []}
    for s in frm:
        if s["id"] in into_ids:
            plan["already"].append({"source": s})
            continue
        same = by_hash.get(s["content_hash"]) if s["content_hash"] else None
        if same is not None:
            plan["duplicates"].append({"source": s, "into": same})
            continue
        plan["move"].append({"source": s})
        other = (by_uri.get(s["uri"]) if s["uri"] else None) or by_title.get((s["title"] or "").strip().lower())
        if other is not None:
            plan["versions"].append({"source": s, "into": other})
    return plan


@router.get("/notebooks/{into_id}/merge-preview")
def merge_preview(
    into_id: str, from_: Annotated[str, Query(alias="from", min_length=1)], workspace_id: str | None = None
) -> dict[str, Any]:
    with sessions().begin() as db:
        plan = _plan(_sources(db, into_id, workspace_id), _sources(db, from_, workspace_id))

    def ref(e: dict[str, Any]) -> dict[str, Any]:
        return {"id": e["source"]["id"], "title": e["source"]["title"]}

    return {
        "move": [ref(e) for e in plan["move"]],
        "already": [ref(e) for e in plan["already"]],
        "duplicates": [
            {**ref(e), "into_id": e["into"]["id"], "into_title": e["into"]["title"]} for e in plan["duplicates"]
        ],
        "versions": [{**ref(e), "into_id": e["into"]["id"]} for e in plan["versions"]],
    }


class MergeBody(BaseModel):
    from_id: str = Field(min_length=1, max_length=200)
    workspace_id: str | None = Field(default=None, max_length=200)


@router.post("/notebooks/{into_id}/merge")
def merge_notebooks(into_id: str, body: MergeBody) -> dict[str, Any]:
    frm = body.from_id
    with sessions().begin() as db:
        plan = _plan(_sources(db, into_id, body.workspace_id), _sources(db, frm, body.workspace_id))
        moved = []
        for e in plan["move"]:
            s = e["source"]
            db.execute(
                text(
                    f"INSERT INTO {S}.notebook_sources (notebook_id, source_id, context_level) "
                    f"VALUES (:nb, :id, :lvl) ON CONFLICT (notebook_id, source_id) DO NOTHING"
                ),
                {"nb": into_id, "id": s["id"], "lvl": s["context_level"]},
            )
            moved.append({"source_id": s["id"], "context_level": s["context_level"]})
        already = [
            {"source_id": e["source"]["id"], "context_level": e["source"]["context_level"]} for e in plan["already"]
        ]
        merged = []
        for e in plan["duplicates"]:
            s, keep = e["source"], e["into"]
            others = db.execute(
                text(
                    f"SELECT count(*) FROM {S}.notebook_sources WHERE source_id = :id AND notebook_id <> :frm"
                ),
                {"id": s["id"], "frm": frm},
            ).scalar_one()
            deleted = int(others) == 0
            if deleted:
                db.execute(
                    text(
                        f"UPDATE {S}.sources SET deleted_at = now(), updated_at = now(), lease_owner = NULL, "
                        f"lease_until = NULL WHERE id = :id"
                    ),
                    {"id": s["id"]},
                )
                db.execute(
                    text(
                        f"UPDATE {S}.source_relations SET status = 'merged' WHERE status = 'suggested' AND "
                        f"((a_id = :a AND b_id = :b) OR (a_id = :b AND b_id = :a))"
                    ),
                    {"a": s["id"], "b": keep["id"]},
                )
            merged.append(
                {
                    "source_id": s["id"],
                    "into_id": keep["id"],
                    "title": s["title"],
                    "kind": s["kind"],
                    "context_level": s["context_level"],
                    "deleted": deleted,
                }
            )
        # B keeps no links: everything it held is in A now.
        db.execute(text(f"DELETE FROM {S}.notebook_sources WHERE notebook_id = :frm"), {"frm": frm})
    return {"moved": moved, "already": already, "merged": merged}


class LinkRec(BaseModel):
    source_id: str
    context_level: str


class MergedRec(BaseModel):
    source_id: str
    into_id: str
    title: str
    kind: str | None = None
    context_level: str
    deleted: bool


class RecordBody(BaseModel):
    moved: list[LinkRec] = Field(default_factory=list, max_length=10_000)
    already: list[LinkRec] = Field(default_factory=list, max_length=10_000)
    merged: list[MergedRec] = Field(default_factory=list, max_length=10_000)


class UndoBody(BaseModel):
    from_id: str = Field(min_length=1, max_length=200)
    workspace_id: str | None = Field(default=None, max_length=200)
    record: RecordBody


@router.post("/notebooks/{into_id}/merge/undo")
def undo_merge(into_id: str, body: UndoBody) -> dict[str, int]:
    frm = body.from_id
    restored = 0
    with sessions().begin() as db:
        relink = [*body.record.moved, *body.record.already]
        for m in body.record.merged:
            if m.deleted:
                db.execute(
                    text(f"UPDATE {S}.sources SET deleted_at = NULL, updated_at = now() WHERE id = :id"),
                    {"id": m.source_id},
                )
            relink.append(LinkRec(source_id=m.source_id, context_level=m.context_level))
        for link in relink:
            db.execute(
                text(
                    f"INSERT INTO {S}.notebook_sources (notebook_id, source_id, context_level) "
                    f"VALUES (:nb, :id, :lvl) ON CONFLICT (notebook_id, source_id) DO NOTHING"
                ),
                {"nb": frm, "id": link.source_id, "lvl": link.context_level},
            )
            restored += 1
        # The sources B brought leave A again; those A held before stay.
        for link in body.record.moved:
            db.execute(
                text(f"DELETE FROM {S}.notebook_sources WHERE notebook_id = :nb AND source_id = :id"),
                {"nb": into_id, "id": link.source_id},
            )
    return {"restored": restored}
