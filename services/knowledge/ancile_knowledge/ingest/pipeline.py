"""
------------------------------------------------------------------
 Title    |  Ingestion pipeline
 Ref      |  DESIGN.md §3.2, §7.6 · ROADMAP.md Phase 3
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  queued → extracting → enriching → embedding → ready,
          |  with meaningful progress at every stage ("Extracting
          |  page 14 of 52") published on NOTIFY ancile_events.
 How      |  The source row's status is the checkpoint. Each stage is
          |  idempotent and keyed by (source_id, pending_version):
          |    extracting  writes v{n}.md and upserts source_versions
          |    enriching   deletes that version's chunks, re-cuts them,
          |                and replaces summary, tags and dedupe hints
          |                in one transaction
          |    embedding   embeds only chunks still missing a vector
          |                for the active model, batch by batch
          |    ready       promotes pending_version to current_version
          |                and drops older versions' chunks
          |  A crash anywhere resumes at the stage it died in, with no
          |  duplicate chunks (tests/test_pipeline_resume.py). The old
          |  version stays searchable until the new one is ready.
 Note     |  No model calls here in phase 3: blurbs come from the
          |  heading path, the summary is extractive, tags are TF-IDF.
          |  TODO(phase-4): model-written insights and blurbs through
          |  core_client, and transformations after embedding.
------------------------------------------------------------------
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import CursorResult, text
from sqlalchemy.orm import Session

from ..db import hnsw_index_sql, sessions
from ..errors import AncileError
from ..obs import get_logger
from ..settings import get_settings
from ..sources import dedupe, repo, tags
from . import embed as embed_mod
from .chunk import ChunkConfig, chunk_markdown
from .enrich import (
    SUMMARY_MODEL,
    SUMMARY_TRANSFORMATION,
    blurb_for,
    embedding_text,
    extractive_summary,
)
from .extract import ExtractInput, extract

log = get_logger("pipeline")

S = "knowledge"

Stage = Literal["queued", "extracting", "enriching", "embedding", "ready", "failed"]

STAGE_ORDER: tuple[Stage, ...] = ("queued", "extracting", "enriching", "embedding", "ready")

LEASE_S = 120
PROGRESS_MIN_INTERVAL_S = 0.25  # at most four progress events per second per source
MAX_ATTEMPTS = 2  # a stage that dies twice goes to failed (DESIGN.md §7.6)


@dataclass
class Progress:
    stage: Stage
    message: str
    done: int | None = None
    total: int | None = None

    def as_event(self, source_id: str, status: str | None = None) -> dict[str, object]:
        event: dict[str, object] = {
            "type": "source.progress",
            "source_id": source_id,
            "status": status or self.stage,
            "stage": self.stage,
            "message": self.message,
        }
        # The event contract has done/total optional, not nullable.
        if self.done is not None:
            event["done"] = self.done
        if self.total is not None:
            event["total"] = self.total
        return event

    def as_json(self) -> dict[str, object]:
        return {"stage": self.stage, "message": self.message, "done": self.done, "total": self.total}


def passages(n: int) -> str:
    return f"{n:,} passage" if n == 1 else f"{n:,} passages"


def next_stage(current: Stage) -> Stage:
    if current in ("ready", "failed"):
        return current
    i = STAGE_ORDER.index(current)
    return STAGE_ORDER[min(i + 1, len(STAGE_ORDER) - 1)]


# Suggestions shown when a stage fails, keyed by error code (DESIGN.md §7.6).
FAILURE_HINTS: dict[str, str] = {
    "extract.scanned_pdf": "This PDF looks scanned. Enable OCR in Settings → Sources, then retry.",
    "extract.engine_missing": "Install the missing extractor, or use the Docker image, then retry.",
    "extract.fetch_failed": "The page could not be fetched. Check the URL, or paste the text instead.",
    "embed.unavailable": "The embedding model is unavailable. Retry, or change the embedder in Settings.",
}


class WorkerStopping(Exception):
    """The service is shutting down: stop at a checkpoint and keep the lease's stage."""


class LeaseLost(Exception):
    """The source was deleted, or another worker took it over."""


def publish(db: Session, event: dict[str, object]) -> None:
    payload = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
    if len(payload.encode()) > 7900:  # NOTIFY payloads must stay under 8 kB
        event = {**event, "message": str(event.get("message", ""))[:500]}
        payload = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
    db.execute(text("SELECT pg_notify('ancile_events', :p)"), {"p": payload})


class Reporter:
    """Persists progress, renews the lease, publishes source.progress; throttled."""

    def __init__(self, source_id: str, worker_id: str, stop: threading.Event | None = None) -> None:
        self.source_id = source_id
        self.worker_id = worker_id
        self.stop = stop
        self._last = 0.0

    def checkpoint(self) -> None:
        if self.stop is not None and self.stop.is_set():
            raise WorkerStopping()

    def __call__(
        self,
        stage: Stage,
        message: str,
        done: int | None = None,
        total: int | None = None,
        *,
        force: bool = False,
    ) -> None:
        self.checkpoint()
        now = time.monotonic()
        if not force and now - self._last < PROGRESS_MIN_INTERVAL_S:
            return
        self._last = now
        p = Progress(stage, message, done, total)
        with sessions().begin() as db:
            n = db.execute(
                text(
                    f"UPDATE {S}.sources SET progress = CAST(:p AS jsonb), "
                    f"lease_until = now() + make_interval(secs => :lease) "
                    f"WHERE id = :id AND lease_owner = :w AND deleted_at IS NULL"
                ),
                {"p": json.dumps(p.as_json()), "lease": LEASE_S, "id": self.source_id, "w": self.worker_id},
            ).rowcount
            if n == 0:
                raise LeaseLost(self.source_id)
            publish(db, p.as_event(self.source_id))


def _transition(
    db: Session,
    source_id: str,
    worker_id: str,
    status: Stage,
    progress: Progress,
    extra_sql: str = "",
    params: dict[str, Any] | None = None,
) -> None:
    """Move to the next stage in the same transaction as the stage's writes."""
    result = db.execute(
        text(
            # attempts = 1: this run is the first attempt at the new stage.
            f"UPDATE {S}.sources SET status = :status, progress = CAST(:p AS jsonb), attempts = 1, "
            f"updated_at = now(), lease_until = now() + make_interval(secs => :lease){extra_sql} "
            f"WHERE id = :id AND lease_owner = :w AND deleted_at IS NULL"
        ),
        {
            "status": status,
            "p": json.dumps(progress.as_json()),
            "lease": LEASE_S,
            "id": source_id,
            "w": worker_id,
            **(params or {}),
        },
    )
    # An UPDATE returns a cursor result, which carries the row count.
    n = result.rowcount if isinstance(result, CursorResult) else 0
    if n == 0:
        raise LeaseLost(source_id)
    publish(db, progress.as_event(source_id, status))


def _load(db: Session, source_id: str) -> dict[str, Any]:
    row = db.execute(text(f"SELECT * FROM {S}.sources WHERE id = :id"), {"id": source_id}).mappings().first()
    if row is None or row["deleted_at"] is not None:
        raise LeaseLost(source_id)
    return dict(row)


# --- stage: queued ------------------------------------------------------------------


def stage_queued(row: dict[str, Any], worker_id: str) -> None:
    with sessions().begin() as db:
        latest = db.execute(
            text(f"SELECT coalesce(max(version), 0) FROM {S}.source_versions WHERE source_id = :id"),
            {"id": row["id"]},
        ).scalar_one()
        version = row["pending_version"] or max(int(latest), int(row["current_version"])) + 1
        _transition(
            db,
            row["id"],
            worker_id,
            "extracting",
            Progress("extracting", "Starting extraction"),
            ", pending_version = :v",
            {"v": version},
        )


# --- stage: extracting ----------------------------------------------------------------


def _extract_input(row: dict[str, Any]) -> ExtractInput:
    kind = row["kind"]
    if kind in ("text", "thread"):
        return ExtractInput(kind=kind, text=repo.read_markdown(repo.input_path(row["id"])))
    if kind == "url":
        refetch = row["current_version"] > 0
        return ExtractInput(
            kind="url",
            url=row["uri"],
            etag=row["etag"] if refetch else None,
            last_modified=row["last_modified"] if refetch else None,
        )
    if kind == "file":
        files = sorted(repo.original_dir(row["id"]).glob("*"))
        if not files:
            raise AncileError(
                "extract.original_missing",
                "The uploaded file is missing",
                "Upload the file again.",
                status=422,
                error_class="permanent",
            )
        return ExtractInput(
            kind="file", path=files[0], filename=row["uri"] or files[0].name, mime=row["mime"]
        )
    raise AncileError(
        "extract.unsupported",
        "This kind of source cannot be read yet",
        "Add it as a file, URL or text.",
        status=422,
        error_class="permanent",
    )


def _record_duplicates(db: Session, row: dict[str, Any], digest: str, sig: list[int]) -> None:
    db.execute(
        text(f"DELETE FROM {S}.source_relations WHERE a_id = :id AND status = 'suggested'"), {"id": row["id"]}
    )
    pool_rows = db.execute(
        text(
            f"SELECT id, content_hash, minhash, uri, title, kind FROM {S}.sources "
            f"WHERE workspace_id = :ws AND id <> :id AND deleted_at IS NULL "
            f"AND content_hash IS NOT NULL AND minhash IS NOT NULL"
        ),
        {"ws": row["workspace_id"], "id": row["id"]},
    ).mappings()
    new = dedupe.Candidate(row["id"], digest, sig, row["uri"], None if row["title_auto"] else row["title"])
    pool = []
    same_uri: list[str] = []
    for p in pool_rows:
        if len(p["minhash"] or []) != len(sig):
            continue
        pool.append(dedupe.Candidate(p["id"], p["content_hash"], list(p["minhash"]), p["uri"], p["title"]))
        if (
            row["kind"] == "url"
            and p["kind"] == "url"
            and p["uri"] == row["uri"]
            and p["content_hash"] != digest
        ):
            same_uri.append(p["id"])
    matches = dedupe.find_matches(new, pool)
    seen = {m.other_id for m in matches}
    for other in same_uri:  # same URL, different content: a newer version of that page
        if other not in seen:
            other_sig = next(c.sig for c in pool if c.id == other)
            matches.append(dedupe.Match(other, "new_version", dedupe.similarity(sig, other_sig)))
    for m in matches[:3]:
        db.execute(
            text(
                f"INSERT INTO {S}.source_relations (a_id, b_id, kind, score, status) "
                f"SELECT :a, :b, :kind, :score, 'suggested' WHERE NOT EXISTS ("
                f"  SELECT 1 FROM {S}.source_relations WHERE a_id = :b AND b_id = :a) "
                f"ON CONFLICT (a_id, b_id) DO UPDATE SET kind = EXCLUDED.kind, score = EXCLUDED.score "
                f"WHERE {S}.source_relations.status = 'suggested'"
            ),
            {"a": row["id"], "b": m.other_id, "kind": m.kind, "score": m.score},
        )


async def stage_extracting(row: dict[str, Any], report: Reporter) -> None:
    settings = get_settings()
    version = int(row["pending_version"])
    report("extracting", "Reading the source", force=True)

    def on_progress(done: int | None, total: int | None, message: str) -> None:
        report("extracting", message, done, total)

    doc = await extract(
        _extract_input(row),
        allow_private=settings.allow_private_urls,
        max_fetch_bytes=settings.max_fetch_mb * 1024 * 1024,
        on_progress=on_progress,
    )
    report.checkpoint()
    is_url = row["kind"] == "url"
    url_meta = ", fetched_at = now(), etag = :etag, last_modified = :lm, stale = false, stale_after = NULL"
    url_params = {"etag": doc.etag, "lm": doc.last_modified}

    unchanged = doc.not_modified or (
        row["current_version"] > 0
        and doc.markdown
        and dedupe.content_hash(doc.markdown) == row["content_hash"]
    )
    if unchanged:
        with sessions().begin() as db:
            _transition(
                db,
                row["id"],
                report.worker_id,
                "ready",
                Progress("ready", "No changes since the last fetch"),
                ", pending_version = NULL" + (url_meta if is_url else ""),
                url_params if is_url else {},
            )
        return

    markdown = doc.markdown
    if not markdown.strip():
        raise AncileError(
            "extract.empty",
            "No text was found in this source",
            "Check the source has readable text. For images or scans, enable OCR in Settings → Sources.",
            status=422,
            error_class="permanent",
        )
    digest = dedupe.content_hash(markdown)
    sig = dedupe.signature(markdown)
    path = repo.markdown_path(row["id"], version)
    repo.write_atomic(path, markdown)
    pages = [p.as_dict() for p in doc.pages]

    with sessions().begin() as db:
        db.execute(
            text(
                f"INSERT INTO {S}.source_versions "
                f"(source_id, version, markdown_path, extractor, content_hash, pages, chars) "
                f"VALUES (:id, :v, :path, :engine, :hash, CAST(:pages AS jsonb), :chars) "
                f"ON CONFLICT (source_id, version) DO UPDATE SET markdown_path = EXCLUDED.markdown_path, "
                f"extractor = EXCLUDED.extractor, content_hash = EXCLUDED.content_hash, "
                f"pages = EXCLUDED.pages, chars = EXCLUDED.chars, extracted_at = now()"
            ),
            {
                "id": row["id"],
                "v": version,
                "path": str(path),
                "engine": doc.engine,
                "hash": digest,
                "pages": json.dumps(pages),
                "chars": len(markdown),
            },
        )
        title = (doc.title or "").strip()[:400]
        _record_duplicates(
            db, row | {"title": title if (row["title_auto"] and title) else row["title"]}, digest, sig
        )
        page_note = f" from {len(pages):,} pages" if pages else ""
        _transition(
            db,
            row["id"],
            report.worker_id,
            "enriching",
            Progress("enriching", f"Extracted {len(markdown):,} characters{page_note}"),
            ", content_hash = :hash, minhash = CAST(:sig AS jsonb), mime = coalesce(mime, :mime)"
            ", title = CASE WHEN title_auto AND :title <> '' THEN :title ELSE title END"
            + (url_meta if is_url else ""),
            {"hash": digest, "sig": json.dumps(sig), "mime": doc.mime, "title": title, **url_params},
        )


# --- stage: enriching ---------------------------------------------------------------


def _page_for(pages: list[dict[str, int]], pos: int) -> int | None:
    page = None
    for p in pages:
        if p["char_start"] <= pos:
            page = p["page"]
        else:
            break
    return page


def chunk_config() -> ChunkConfig:
    s = get_settings()
    return ChunkConfig(
        max_tokens=s.chunk_tokens,
        overlap_tokens=s.chunk_overlap,
        parent_max_tokens=max(2048, s.chunk_tokens * 4),
    )


def stage_enriching(row: dict[str, Any], report: Reporter) -> None:
    version = int(row["pending_version"])
    with sessions().begin() as db:
        ver = (
            db.execute(
                text(
                    f"SELECT markdown_path, pages FROM {S}.source_versions "
                    f"WHERE source_id = :id AND version = :v"
                ),
                {"id": row["id"], "v": version},
            )
            .mappings()
            .first()
        )
    if ver is None:  # extraction never finished for this version: start it again
        with sessions().begin() as db:
            _transition(db, row["id"], report.worker_id, "extracting", Progress("extracting", "Re-reading"))
        return
    markdown = repo.read_markdown(repo.markdown_path(row["id"], version))
    pages: list[dict[str, int]] = list(ver["pages"] or [])
    report("enriching", "Cutting passages", force=True)
    result = chunk_markdown(markdown, chunk_config())
    n_children = len(result.children)
    report("enriching", f"Cutting {passages(n_children)}", 0, n_children)

    title = row["title"]
    prefix = f"{row['id']}:{version}:"
    parent_ids = {p.ordinal: f"{prefix}{p.ordinal}" for p in result.parents}
    contextual = get_settings().contextual_chunks

    def chunk_row(c: Any, parent_id: str | None) -> dict[str, Any]:
        return {
            "id": f"{prefix}{c.ordinal}",
            "source_id": row["id"],
            "version": version,
            "ordinal": c.ordinal,
            "parent_id": parent_id,
            "text": c.text,
            "blurb": blurb_for(title, c.heading_path) if contextual else None,
            "heading_path": c.heading_path,
            "page": _page_for(pages, c.char_start),
            "char_start": c.char_start,
            "char_end": c.char_end,
            "tokens": c.tokens,
        }

    parents = [chunk_row(p, None) for p in result.parents]
    children = [
        chunk_row(c, parent_ids[c.parent_ordinal] if c.parent_ordinal is not None else None)
        for c in result.children
    ]

    summary = extractive_summary(markdown)
    counts = tags.terms(markdown, title)
    insert = text(
        f"INSERT INTO {S}.chunks (id, source_id, version, ordinal, parent_id, text, context_blurb, "
        f"heading_path, page, char_start, char_end, tokens) VALUES (:id, :source_id, :version, :ordinal, "
        f":parent_id, :text, :blurb, :heading_path, :page, :char_start, :char_end, :tokens)"
    )
    with sessions().begin() as db:
        # Idempotent: this version's chunks (and their embeddings) are replaced wholesale.
        # Children cascade from their parents; embeddings cascade from chunks.
        db.execute(
            text(f"DELETE FROM {S}.chunks WHERE source_id = :id AND version = :v"),
            {"id": row["id"], "v": version},
        )
        if parents:
            db.execute(insert, parents)
        if children:
            db.execute(insert, children)

        db.execute(
            text(f"DELETE FROM {S}.insights WHERE source_id = :id AND transformation_id = :t"),
            {"id": row["id"], "t": SUMMARY_TRANSFORMATION},
        )
        if summary:
            db.execute(
                text(
                    f"INSERT INTO {S}.insights (id, source_id, transformation_id, content_md, model_id) "
                    f"VALUES (:iid, :id, :t, :c, :m)"
                ),
                {
                    "iid": f"ins_{row['id']}_summary",
                    "id": row["id"],
                    "t": SUMMARY_TRANSFORMATION,
                    "c": summary,
                    "m": SUMMARY_MODEL,
                },
            )

        topics = dict(row.get("topics") or {})
        top = tags.top_terms(counts)
        others = (
            db.execute(
                text(
                    f"SELECT topics->'terms' AS terms FROM {S}.sources "
                    f"WHERE workspace_id = :ws AND id <> :id "
                    f"AND deleted_at IS NULL AND topics ? 'terms'"
                ),
                {"ws": row["workspace_id"], "id": row["id"]},
            )
            .scalars()
            .all()
        )
        df: dict[str, int] = {}
        for t in others:
            for term in t or {}:
                df[term] = df.get(term, 0) + 1
        auto = topics.get("tags_auto", True) or not row.get("tags")
        new_tags = tags.pick_tags(counts, df, len(others) + 1) if auto else list(row.get("tags") or [])
        topics.update({"terms": top, "tags_auto": auto})

        _transition(
            db,
            row["id"],
            report.worker_id,
            "embedding",
            Progress("embedding", f"Embedding {passages(n_children)}", 0, n_children),
            ", tags = :tags, topics = CAST(:topics AS jsonb)",
            {"tags": new_tags, "topics": json.dumps(topics)},
        )


# --- stage: embedding ---------------------------------------------------------------

_indexed: set[str] = set()
_index_lock = threading.Lock()


def ensure_vector_index(model_key: str, dim: int) -> None:
    """CREATE INDEX CONCURRENTLY cannot run in a transaction: autocommit, once per model."""
    if model_key in _indexed:
        return
    with _index_lock:
        if model_key in _indexed:
            return
        from ..db import get_engine

        try:
            eng = get_engine(get_settings().sqlalchemy_url)
            with eng.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
                conn.execute(text("SET lock_timeout = '10s'"))
                conn.execute(text(hnsw_index_sql(model_key, dim)))
            _indexed.add(model_key)
        except Exception as exc:  # search still works without it, only slower
            log.warning("vector index not created", model=model_key, error=type(exc).__name__)


def _finish(db: Session, row: dict[str, Any], worker_id: str, version: int, message: str) -> None:
    db.execute(
        text(f"DELETE FROM {S}.chunks WHERE source_id = :id AND version <> :v"),
        {"id": row["id"], "v": version},
    )
    _transition(
        db,
        row["id"],
        worker_id,
        "ready",
        Progress("ready", message),
        ", current_version = :v, pending_version = NULL, error = NULL",
        {"v": version},
    )


def stage_embedding(row: dict[str, Any], report: Reporter) -> None:
    version = int(row["pending_version"])
    with sessions().begin() as db:
        total = db.execute(
            text(
                f"SELECT count(*) FROM {S}.chunks "
                f"WHERE source_id = :id AND version = :v AND parent_id IS NOT NULL"
            ),
            {"id": row["id"], "v": version},
        ).scalar_one()
    if total == 0:
        with sessions().begin() as db:
            _finish(db, row, report.worker_id, version, "Ready")
        return
    try:
        embedder = embed_mod.get_embedder(download=True)
    except AncileError as exc:
        # Text search still works: finish as ready, and say what is missing.
        log.warning("embedding skipped", source_id=row["id"], code=exc.code)
        with sessions().begin() as db:
            _finish(
                db,
                row,
                report.worker_id,
                version,
                "Ready for text search. Vector search is unavailable until the embedding model loads.",
            )
        return
    ensure_vector_index(embedder.model_key, embedder.dim)
    batch_size = get_settings().embed_batch
    report("embedding", f"Embedding {passages(total)}", 0, total, force=True)
    while True:
        with sessions().begin() as db:
            todo = db.execute(
                text(
                    f"SELECT c.id, c.context_blurb, c.text FROM {S}.chunks c WHERE c.source_id = :id "
                    f"AND c.version = :v AND c.parent_id IS NOT NULL AND NOT EXISTS ("
                    f"  SELECT 1 FROM {S}.chunk_embeddings e WHERE e.chunk_id = c.id AND e.model_key = :mk) "
                    f"ORDER BY c.ordinal LIMIT :n"
                ),
                {"id": row["id"], "v": version, "mk": embedder.model_key, "n": batch_size},
            ).all()
        if not todo:
            break
        vectors = embedder.embed([embedding_text(b, t) for _, b, t in todo])
        with sessions().begin() as db:
            db.execute(
                text(
                    f"INSERT INTO {S}.chunk_embeddings (chunk_id, model_key, embedding) "
                    f"VALUES (:cid, :mk, CAST(:vec AS vector)) ON CONFLICT DO NOTHING"
                ),
                [
                    {"cid": cid, "mk": embedder.model_key, "vec": _vec_literal(vec)}
                    for (cid, _, _), vec in zip(todo, vectors, strict=True)
                ],
            )
            done = db.execute(
                text(
                    f"SELECT count(*) FROM {S}.chunk_embeddings e JOIN {S}.chunks c ON c.id = e.chunk_id "
                    f"WHERE c.source_id = :id AND c.version = :v AND e.model_key = :mk"
                ),
                {"id": row["id"], "v": version, "mk": embedder.model_key},
            ).scalar_one()
        pct = round(100 * done / total)
        report("embedding", f"Embedding {passages(total)} · {pct}%", int(done), int(total))
    with sessions().begin() as db:
        _finish(db, row, report.worker_id, version, f"Ready · {passages(total)}")


def _vec_literal(vec: list[float]) -> str:
    return "[" + ",".join(f"{x:.7g}" for x in vec) + "]"


# --- driver -------------------------------------------------------------------------


async def run_source(source_id: str, worker_id: str, stop: threading.Event | None = None) -> str:
    """
    Drive one claimed source through its remaining stages. Returns the final
    status. Raises AncileError for a stage failure (the worker records it),
    WorkerStopping at a checkpoint during shutdown, LeaseLost if the source
    went away.
    """
    report = Reporter(source_id, worker_id, stop)
    while True:
        report.checkpoint()
        with sessions().begin() as db:
            row = _load(db, source_id)
        status = row["status"]
        log.info("stage", source_id=source_id, stage=status, version=row["pending_version"])
        if status == "queued":
            stage_queued(row, worker_id)
        elif status == "extracting":
            await stage_extracting(row, report)
        elif status == "enriching":
            stage_enriching(row, report)
        elif status == "embedding":
            stage_embedding(row, report)
        else:
            return str(status)
