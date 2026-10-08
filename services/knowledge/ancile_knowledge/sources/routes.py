"""
------------------------------------------------------------------
 Title    |  /kn/v1 sources, notebook links, duplicates, maintenance
 Ref      |  DESIGN.md §4.2 · packages/contracts/src/knowledge.ts
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Add, read, change and remove sources; link them to Core's
          |  notebooks with a context level; read a source's extracted
          |  text with page and heading offsets; act on duplicate and
          |  staleness suggestions.
 How      |  Mounted under the service-token router in routes.py.
          |  Handlers are sync (FastAPI runs them in a thread) because
          |  the database layer is sync psycopg; adding a source only
          |  writes a row and wakes the in-process worker (jobs.py),
          |  which does the slow part. Every response uses the
          |  contract's field names exactly.
 Note     |  Notebooks live in Core: Knowledge stores only the links
          |  (notebook_sources) and trusts Core for notebook existence
          |  and ownership. workspace_id comes from Core as well.
------------------------------------------------------------------
"""

from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urlparse

from fastapi import APIRouter, File, Form, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import text

from .. import jobs
from ..db import sessions
from ..errors import AncileError
from ..ingest.chunk import outline
from ..ingest.extract import guess_mime
from ..offsets import U16Map
from ..settings import get_settings
from . import repo
from .repo import S

router = APIRouter()

ContextLevel = Literal["off", "insights", "full"]
MAX_TEXT_CHARS = 5_000_000


def _invalid(title: str, hint: str) -> AncileError:
    return AncileError("request.invalid", title, hint, status=422, error_class="permanent")


def _conflict(code: str, title: str, hint: str) -> AncileError:
    return AncileError(code, title, hint, status=409, error_class="permanent")


# --- add ----------------------------------------------------------------------------


class AddSourceBody(BaseModel):
    workspace_id: str = Field(min_length=1, max_length=200)
    kind: Literal["url", "text", "thread"]
    url: str | None = Field(default=None, max_length=4000)
    text: str | None = Field(default=None, max_length=MAX_TEXT_CHARS)
    thread_id: str | None = Field(default=None, max_length=200)
    title: str | None = Field(default=None, max_length=400)
    notebook_id: str | None = None
    notebook_ids: list[str] = Field(default_factory=list, max_length=50)


def _link(db: Any, source_id: str, notebook_ids: list[str], level: str = "full") -> None:
    for nb in dict.fromkeys(n for n in notebook_ids if n):
        db.execute(
            text(
                f"INSERT INTO {S}.notebook_sources (notebook_id, source_id, context_level) "
                f"VALUES (:nb, :id, :lvl) "
                f"ON CONFLICT (notebook_id, source_id) DO NOTHING"
            ),
            {"nb": nb, "id": source_id, "lvl": level},
        )


def _insert_source(db: Any, **cols: Any) -> None:
    db.execute(
        text(
            f"INSERT INTO {S}.sources (id, workspace_id, kind, title, uri, mime, bytes, status, progress, "
            f"tags, topics, title_auto) "
            f"VALUES (:id, :workspace_id, :kind, :title, :uri, :mime, :bytes, 'queued', "
            f"CAST(:progress AS jsonb), '{{}}', '{{}}', :title_auto)"
        ),
        {
            "mime": None,
            "bytes": None,
            "progress": json.dumps({"stage": "queued", "message": "Waiting to start"}),
            **cols,
        },
    )


def _default_title(body: AddSourceBody) -> str:
    if body.kind == "url" and body.url:
        p = urlparse(body.url)
        return (p.netloc + p.path).rstrip("/")[:400] or body.url[:400]
    first = next((ln.strip(" #\t") for ln in (body.text or "").splitlines() if ln.strip()), "")
    if body.kind == "thread":
        return f"Thread: {first[:72]}" if first else "Thread"
    return first[:80] or "Pasted text"


def _created(source_id: str) -> JSONResponse:
    with sessions().begin() as db:
        row = repo.get_source_row(db, source_id)
    jobs.wake_worker()  # after reading, so the response shows the source as queued
    return JSONResponse(repo.serialize(row), status_code=201)


@router.post("/sources", status_code=201)
def add_source(body: AddSourceBody) -> JSONResponse:
    if body.kind == "url":
        if not body.url:
            raise _invalid("A URL source needs a url", "Send the page address in url.")
        parsed = urlparse(body.url.strip())
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise _invalid("That is not a web address Ancile can fetch", "Use a full http or https link.")
        uri: str | None = body.url.strip()
    elif body.kind == "text":
        if not body.text or not body.text.strip():
            raise _invalid("A text source needs some text", "Paste the text to add.")
        uri = None
    else:
        if not body.thread_id or not body.text or not body.text.strip():
            raise _invalid("A thread source needs its thread_id and transcript", "Send thread_id and text.")
        uri = body.thread_id

    source_id = repo.new_id()
    if body.kind in ("text", "thread"):
        repo.write_atomic(repo.input_path(source_id), body.text or "")
    title = (body.title or "").strip()
    with sessions().begin() as db:
        _insert_source(
            db,
            id=source_id,
            workspace_id=body.workspace_id,
            kind=body.kind,
            title=title or _default_title(body),
            uri=uri,
            mime="text/markdown" if body.kind != "url" else None,
            bytes=len((body.text or "").encode()) if body.kind != "url" else None,
            title_auto=not title,
        )
        _link(db, source_id, [*body.notebook_ids, *([body.notebook_id] if body.notebook_id else [])])
    return _created(source_id)


@router.post("/sources/upload", status_code=201)
def upload_source(
    file: Annotated[UploadFile, File()],
    workspace_id: Annotated[str, Form(min_length=1, max_length=200)],
    title: Annotated[str | None, Form(max_length=400)] = None,
    notebook_id: Annotated[str | None, Form()] = None,
    notebook_ids: Annotated[str | None, Form()] = None,
) -> JSONResponse:
    settings = get_settings()
    limit = settings.max_upload_mb * 1024 * 1024
    name = repo.safe_filename(file.filename)
    source_id = repo.new_id()
    dest_dir = repo.original_dir(source_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / name
    size = 0
    try:
        with open(dest, "wb") as out:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise AncileError(
                        "source.too_large",
                        f"{name} is larger than the {settings.max_upload_mb} MB limit",
                        "Split it, or raise KNOWLEDGE_MAX_UPLOAD_MB in Settings → Sources.",
                        status=413,
                        error_class="permanent",
                    )
                out.write(chunk)
    except BaseException:
        shutil.rmtree(repo.source_dir(source_id), ignore_errors=True)
        raise
    if size == 0:
        shutil.rmtree(repo.source_dir(source_id), ignore_errors=True)
        raise _invalid("The uploaded file is empty", "Choose the file again.")
    mime = guess_mime(file.filename, file.content_type)
    nbs = [n.strip() for n in (notebook_ids or "").split(",") if n.strip()]
    clean_title = (title or "").strip()
    with sessions().begin() as db:
        _insert_source(
            db,
            id=source_id,
            workspace_id=workspace_id,
            kind="file",
            title=clean_title or Path(name).stem or name,
            uri=file.filename or name,
            mime=mime,
            bytes=size,
            title_auto=False,
        )
        _link(db, source_id, [*nbs, *([notebook_id] if notebook_id else [])])
    return _created(source_id)


# --- read ---------------------------------------------------------------------------


@router.get("/sources")
def list_sources(workspace_id: str | None = None, ids: str | None = None) -> list[dict[str, Any]]:
    id_list = [i for i in (ids or "").split(",") if i] if ids is not None else None
    if workspace_id is None and not id_list:
        raise _invalid("Say which sources to list", "Send workspace_id, ids, or both.")
    with sessions().begin() as db:
        rows = repo.fetch_sources(db, ids=id_list, workspace_id=workspace_id)
    return [repo.serialize(r) for r in rows]


@router.get("/sources/{source_id}")
def get_source(source_id: str, workspace_id: str | None = None) -> dict[str, Any]:
    with sessions().begin() as db:
        return repo.serialize(repo.get_source_row(db, source_id, workspace_id))


@router.get("/sources/{source_id}/content")
def get_content(source_id: str, workspace_id: str | None = None) -> dict[str, Any]:
    with sessions().begin() as db:
        row = repo.get_source_row(db, source_id, workspace_id)
        version = int(row["current_version"])
        ver = None
        if version > 0:
            ver = (
                db.execute(
                    text(f"SELECT pages FROM {S}.source_versions WHERE source_id = :id AND version = :v"),
                    {"id": source_id, "v": version},
                )
                .mappings()
                .first()
            )
    if version == 0 or ver is None:
        raise _conflict(
            "source.not_ready",
            "This source is still being read",
            "Wait until it is ready, then open it again.",
        )
    markdown = repo.read_markdown(repo.markdown_path(source_id, version))
    # Offsets leave in UTF-16 units, the way the Cockpit slices text.
    u16 = U16Map(markdown)
    pages = [
        {**p, "char_start": u16(p["char_start"]), "char_end": u16(p["char_end"])} if "char_start" in p else p
        for p in (ver["pages"] or [])
    ]
    return {
        "source_id": source_id,
        "version": version,
        "markdown": markdown,
        "pages": pages,
        "outline": [{**h, "char_start": u16(int(str(h["char_start"])))} for h in outline(markdown)],
    }


@router.get("/sources/{source_id}/file", response_model=None)
def get_file(source_id: str, workspace_id: str | None = None) -> FileResponse:
    with sessions().begin() as db:
        row = repo.get_source_row(db, source_id, workspace_id)
    files = sorted(repo.original_dir(source_id).glob("*")) if row["kind"] == "file" else []
    if not files:
        raise AncileError(
            "source.no_original",
            "There is no original file for this source",
            "Only uploaded files keep an original. Open the extracted text instead.",
            status=404,
            error_class="permanent",
        )
    return FileResponse(
        files[0], media_type=row["mime"] or "application/octet-stream", filename=files[0].name
    )


# --- change -------------------------------------------------------------------------


class PatchSourceBody(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=400)
    tags: list[Annotated[str, Field(max_length=60)]] | None = Field(default=None, max_length=40)


@router.patch("/sources/{source_id}")
def patch_source(source_id: str, body: PatchSourceBody, workspace_id: str | None = None) -> dict[str, Any]:
    with sessions().begin() as db:
        repo.get_source_row(db, source_id, workspace_id)
        if body.title is not None:
            db.execute(
                text(
                    f"UPDATE {S}.sources SET title = :t, title_auto = false, updated_at = now() "
                    f"WHERE id = :id"
                ),
                {"t": body.title.strip(), "id": source_id},
            )
        if body.tags is not None:
            clean = list(dict.fromkeys(t.strip() for t in body.tags if t.strip()))
            db.execute(
                text(
                    f"UPDATE {S}.sources SET tags = :tags, updated_at = now(), "
                    f"topics = topics || jsonb_build_object('tags_auto', false) WHERE id = :id"
                ),
                {"tags": clean, "id": source_id},
            )
        return repo.serialize(repo.get_source_row(db, source_id))


@router.delete("/sources/{source_id}", status_code=204)
def delete_source(source_id: str, workspace_id: str | None = None) -> None:
    """Soft delete: gone from lists, notebooks and search; files kept for recovery."""
    with sessions().begin() as db:
        repo.get_source_row(db, source_id, workspace_id)
        db.execute(
            text(
                f"UPDATE {S}.sources SET deleted_at = now(), updated_at = now(), lease_owner = NULL, "
                f"lease_until = NULL WHERE id = :id"
            ),
            {"id": source_id},
        )
        db.execute(text(f"DELETE FROM {S}.notebook_sources WHERE source_id = :id"), {"id": source_id})
        # TODO(phase-5): purge files and rows of sources deleted more than 30 days ago.


@router.post("/sources/{source_id}/retry")
def retry_source(source_id: str, workspace_id: str | None = None) -> dict[str, Any]:
    with sessions().begin() as db:
        row = repo.get_source_row(db, source_id, workspace_id)
        if row["status"] != "failed":
            raise _conflict(
                "source.not_failed", "Only a failed source can be retried", "This one has not failed."
            )
        stage = (row["error"] or {}).get("stage") or "queued"
        if stage not in repo.ACTIVE or (stage != "queued" and row["pending_version"] is None):
            stage = "queued"
        db.execute(
            text(
                f"UPDATE {S}.sources SET status = :st, error = NULL, attempts = 0, lease_owner = NULL, "
                f"lease_until = NULL, progress = CAST(:p AS jsonb), updated_at = now() WHERE id = :id"
            ),
            {"st": stage, "id": source_id, "p": json.dumps({"stage": stage, "message": "Waiting to retry"})},
        )
        out = repo.serialize(repo.get_source_row(db, source_id))
    jobs.wake_worker()
    return out


@router.post("/sources/{source_id}/refetch")
def refetch_source(source_id: str, workspace_id: str | None = None) -> dict[str, Any]:
    with sessions().begin() as db:
        row = repo.get_source_row(db, source_id, workspace_id)
        if row["kind"] != "url":
            raise _conflict(
                "source.refetch_unsupported",
                "Only web pages can be fetched again",
                "To update a file, upload the new version as a source.",
            )
        if row["status"] in repo.ACTIVE:
            raise _conflict(
                "source.busy",
                "This source is still being read",
                "Wait until it is ready, then fetch it again.",
            )
        db.execute(
            text(
                f"UPDATE {S}.sources SET status = 'queued', pending_version = NULL, error = NULL, "
                f"attempts = 0, "
                f"stale = false, lease_owner = NULL, lease_until = NULL, updated_at = now(), "
                f"progress = CAST(:p AS jsonb) WHERE id = :id"
            ),
            {"id": source_id, "p": json.dumps({"stage": "queued", "message": "Waiting to fetch again"})},
        )
        out = repo.serialize(repo.get_source_row(db, source_id))
    jobs.wake_worker()
    return out


# --- notebook links -----------------------------------------------------------------


@router.get("/notebooks/{notebook_id}/sources")
def notebook_sources(notebook_id: str, workspace_id: str | None = None) -> list[dict[str, Any]]:
    with sessions().begin() as db:
        links = dict(
            db.execute(
                text(f"SELECT source_id, context_level FROM {S}.notebook_sources WHERE notebook_id = :nb"),
                {"nb": notebook_id},
            ).all()
        )
        rows = repo.fetch_sources(db, ids=list(links), workspace_id=workspace_id) if links else []
    return [repo.serialize(r, links[r["id"]]) for r in rows]


class LinkBody(BaseModel):
    context_level: ContextLevel | None = None


@router.put("/notebooks/{notebook_id}/sources/{source_id}")
def link_source(
    notebook_id: str, source_id: str, body: LinkBody | None = None, workspace_id: str | None = None
) -> dict[str, Any]:
    level = body.context_level if body else None
    with sessions().begin() as db:
        repo.get_source_row(db, source_id, workspace_id)
        db.execute(
            text(
                f"INSERT INTO {S}.notebook_sources (notebook_id, source_id, context_level) "
                f"VALUES (:nb, :id, coalesce(:lvl, 'full')) ON CONFLICT (notebook_id, source_id) "
                f"DO UPDATE SET context_level = coalesce(:lvl, {S}.notebook_sources.context_level)"
            ),
            {"nb": notebook_id, "id": source_id, "lvl": level},
        )
        actual = db.execute(
            text(
                f"SELECT context_level FROM {S}.notebook_sources WHERE notebook_id = :nb AND source_id = :id"
            ),
            {"nb": notebook_id, "id": source_id},
        ).scalar_one()
        return repo.serialize(repo.get_source_row(db, source_id), actual)


@router.delete("/notebooks/{notebook_id}/sources/{source_id}", status_code=204)
def unlink_source(notebook_id: str, source_id: str) -> None:
    with sessions().begin() as db:
        db.execute(
            text(f"DELETE FROM {S}.notebook_sources WHERE notebook_id = :nb AND source_id = :id"),
            {"nb": notebook_id, "id": source_id},
        )


@router.get("/notebooks/{notebook_id}/stats")
def notebook_stats(notebook_id: str) -> dict[str, int]:
    with sessions().begin() as db:
        row = (
            db.execute(
                text(
                    f"SELECT count(*) AS sources, count(*) FILTER (WHERE s.status = 'ready') AS ready, "
                    f"coalesce(sum((SELECT count(*) FROM {S}.chunks c WHERE c.source_id = s.id "
                    f"  AND c.version = s.current_version AND c.parent_id IS NOT NULL)), 0) AS chunks "
                    f"FROM {S}.notebook_sources ns JOIN {S}.sources s ON s.id = ns.source_id "
                    f"WHERE ns.notebook_id = :nb AND s.deleted_at IS NULL"
                ),
                {"nb": notebook_id},
            )
            .mappings()
            .one()
        )
    return {"sources": int(row["sources"]), "ready": int(row["ready"]), "chunks": int(row["chunks"])}


# --- duplicates ---------------------------------------------------------------------


@router.get("/duplicates")
def list_duplicates(workspace_id: Annotated[str, Query(min_length=1)]) -> list[dict[str, Any]]:
    with sessions().begin() as db:
        rels = (
            db.execute(
                text(
                    f"SELECT r.a_id, r.b_id, r.kind, r.score, r.created_at FROM {S}.source_relations r "
                    f"JOIN {S}.sources a ON a.id = r.a_id AND a.deleted_at IS NULL "
                    f"JOIN {S}.sources b ON b.id = r.b_id AND b.deleted_at IS NULL "
                    f"WHERE r.status = 'suggested' AND a.workspace_id = :ws ORDER BY r.created_at DESC"
                ),
                {"ws": workspace_id},
            )
            .mappings()
            .all()
        )
        ids = sorted({r["a_id"] for r in rels} | {r["b_id"] for r in rels})
        by_id = {r["id"]: r for r in repo.fetch_sources(db, ids=ids)} if ids else {}
    return [
        {
            "a_id": r["a_id"],
            "b_id": r["b_id"],
            "kind": r["kind"],
            "score": round(float(r["score"]), 4),
            "created_at": r["created_at"].isoformat(),
            "source": repo.serialize(by_id[r["a_id"]]),
            "duplicate_of": repo.serialize(by_id[r["b_id"]]),
        }
        for r in rels
        if r["a_id"] in by_id and r["b_id"] in by_id
    ]


class MergeBody(BaseModel):
    keep_id: str
    drop_id: str


@router.post("/sources/merge")
def merge_sources(body: MergeBody, workspace_id: str | None = None) -> dict[str, Any]:
    if body.keep_id == body.drop_id:
        raise _invalid("A source cannot be merged into itself", "Choose two different sources.")
    with sessions().begin() as db:
        keep = repo.get_source_row(db, body.keep_id, workspace_id)
        drop = repo.get_source_row(db, body.drop_id, workspace_id)
        if keep["workspace_id"] != drop["workspace_id"]:
            raise repo.not_found()
        params = {"keep": body.keep_id, "drop": body.drop_id}
        # Links move to the kept source; where both were linked, the kept link wins.
        db.execute(
            text(
                f"INSERT INTO {S}.notebook_sources (notebook_id, source_id, context_level) "
                f"SELECT notebook_id, :keep, context_level FROM {S}.notebook_sources WHERE source_id = :drop "
                f"ON CONFLICT (notebook_id, source_id) DO NOTHING"
            ),
            params,
        )
        db.execute(text(f"DELETE FROM {S}.notebook_sources WHERE source_id = :drop"), params)
        db.execute(
            text(
                f"UPDATE {S}.sources SET deleted_at = now(), updated_at = now(), lease_owner = NULL, "
                f"lease_until = NULL WHERE id = :drop"
            ),
            params,
        )
        db.execute(
            text(
                f"UPDATE {S}.source_relations SET status = 'merged' WHERE status = 'suggested' AND "
                f"((a_id = :keep AND b_id = :drop) OR (a_id = :drop AND b_id = :keep))"
            ),
            params,
        )
        return repo.serialize(repo.get_source_row(db, body.keep_id))


class DismissBody(BaseModel):
    a_id: str
    b_id: str


@router.post("/duplicates/dismiss", status_code=204)
def dismiss_duplicate(body: DismissBody) -> None:
    with sessions().begin() as db:
        n = db.execute(
            text(
                f"UPDATE {S}.source_relations SET status = 'dismissed' WHERE status = 'suggested' AND "
                f"((a_id = :a AND b_id = :b) OR (a_id = :b AND b_id = :a))"
            ),
            {"a": body.a_id, "b": body.b_id},
        ).rowcount
    if n == 0:
        raise repo.not_found("duplicate suggestion")


# --- maintenance --------------------------------------------------------------------


class StaleCheckBody(BaseModel):
    source_ids: list[str] | None = None
    force: bool = False


@router.post("/maintenance/stale-check")
def stale_check(body: StaleCheckBody | None = None) -> dict[str, Any]:
    """Re-validate due URL sources now (the worker also does this on a timer)."""
    from . import stale

    b = body or StaleCheckBody()
    # A worker thread: its own loop, so the blocking database calls stay off the API loop.
    result: dict[str, Any] = asyncio.run(stale.sweep(force=b.force, source_ids=b.source_ids))
    return result
