"""
------------------------------------------------------------------
 Title    |  Background jobs: the in-process ingestion worker
 Ref      |  DESIGN.md §7.6 · ROADMAP.md Phase 3
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Durable, retryable ingestion on Postgres with no extra
          |  process (the product is a desktop app) and no Redis: the
          |  sources table is the queue (DESIGN.md D2).
 How      |  A DB-claim loop, not Procrastinate. One worker thread
          |  with its own event loop, started and stopped by the
          |  FastAPI lifespan, so CPU-heavy stages (PDF text, chunking,
          |  ONNX embedding) never block the API's loop.
          |    claim   UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP
          |            LOCKED) sets a lease (lease_owner, lease_until)
          |            and counts the attempt
          |    run     ingest.pipeline.run_source; every progress
          |            report renews the lease
          |    fail    an AncileError marks the source failed with its
          |            code, title and hint; a crash is retried once,
          |            then fails (a stage that dies twice is failed)
          |    resume  at startup, leases left by a previous process
          |            are released, so stuck sources continue at the
          |            stage they reached; elsewhere an expired lease
          |            is simply claimable again
          |  The same loop runs maintenance: the stale-URL sweep every
          |  KNOWLEDGE_STALE_CHECK_HOURS.
 Note     |  Why not Procrastinate: its worker needs psycopg's async
          |  connection, which cannot run on Windows' default Proactor
          |  event loop (uvicorn's choice there), and this queue needs
          |  per-source stage checkpoints anyway. Releasing all leases
          |  at startup assumes one Knowledge process per database,
          |  which holds for the desktop app.
          |  TODO(phase-5): heartbeat-based recovery for several
          |  Knowledge replicas; concurrency > 1; dead letters in Health.
------------------------------------------------------------------
"""

from __future__ import annotations

import asyncio
import json
import secrets
import threading
import time
from typing import Any

import structlog
from sqlalchemy import text

from .db import sessions
from .errors import AncileError
from .ingest import pipeline
from .obs import SERVICE, get_logger, new_span_id, new_trace_id
from .settings import get_settings

log = get_logger("jobs")

S = "knowledge"
QUEUES = ("ingest", "embed", "maintenance")  # kept for callers of the old module
IDLE_POLL_S = 2.0
RETRY_BACKOFF_S = 15


def claim(worker_id: str) -> dict[str, Any] | None:
    with sessions().begin() as db:
        row = (
            db.execute(
                text(
                    f"UPDATE {S}.sources s SET lease_owner = :w, "
                    f"lease_until = now() + make_interval(secs => :lease), attempts = s.attempts + 1 "
                    f"WHERE s.id = (SELECT id FROM {S}.sources WHERE deleted_at IS NULL "
                    f"  AND status IN ('queued','extracting','enriching','embedding') "
                    f"  AND (lease_until IS NULL OR lease_until < now()) "
                    f"  ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED) "
                    f"RETURNING s.id, s.status, s.attempts"
                ),
                {"w": worker_id, "lease": pipeline.LEASE_S},
            )
            .mappings()
            .first()
        )
    return dict(row) if row else None


def release(source_id: str, worker_id: str, delay_s: float = 0) -> None:
    with sessions().begin() as db:
        db.execute(
            text(
                f"UPDATE {S}.sources SET lease_owner = NULL, "
                f"lease_until = CASE WHEN :d > 0 THEN now() + make_interval(secs => :d) ELSE NULL END "
                f"WHERE id = :id AND lease_owner = :w"
            ),
            {"id": source_id, "w": worker_id, "d": delay_s},
        )


def mark_failed(source_id: str, worker_id: str | None, err: AncileError, stage: str) -> None:
    hint = pipeline.FAILURE_HINTS.get(err.code, err.hint)
    stored = {"code": err.code, "title": err.title, "hint": hint, "stage": stage, "detail": err.detail}
    progress = pipeline.Progress("failed", err.title)
    with sessions().begin() as db:
        n = db.execute(
            text(
                f"UPDATE {S}.sources SET status = 'failed', error = CAST(:e AS jsonb), progress = '{{}}', "
                f"lease_owner = NULL, lease_until = NULL, updated_at = now() "
                f"WHERE id = :id AND (CAST(:w AS text) IS NULL OR lease_owner = :w) AND deleted_at IS NULL"
            ),
            {"id": source_id, "w": worker_id, "e": json.dumps(stored)},
        ).rowcount
        if n:
            pipeline.publish(db, progress.as_event(source_id, "failed"))
    log.warning("source failed", source_id=source_id, stage=stage, code=err.code)


def crashed(detail: str) -> AncileError:
    return AncileError(
        "ingest.crashed",
        "Ingestion stopped unexpectedly",
        "Retry. If it stops again, open Admin → Logs and filter by this source.",
        status=500,
        error_class="bug",
        detail=detail,
    )


def recover_leases() -> int:
    """Release leases from a previous process so its sources resume now."""
    with sessions().begin() as db:
        return int(
            db.execute(
                text(
                    f"UPDATE {S}.sources SET lease_owner = NULL, lease_until = NULL "
                    f"WHERE lease_owner IS NOT NULL AND deleted_at IS NULL"
                )
            ).rowcount
        )


async def process(claimed: dict[str, Any], worker_id: str, stop: threading.Event | None = None) -> str | None:
    """Run one claimed source; record failures. Returns the final status, if known."""
    source_id = claimed["id"]
    # One trace per ingestion run, so its log lines can be followed together.
    structlog.contextvars.bind_contextvars(
        trace_id=new_trace_id(), span_id=new_span_id(), source_id=source_id
    )
    try:
        return await _process(claimed, worker_id, stop)
    finally:
        structlog.contextvars.unbind_contextvars("trace_id", "span_id", "source_id")


async def _process(claimed: dict[str, Any], worker_id: str, stop: threading.Event | None) -> str | None:
    source_id, stage = claimed["id"], claimed["status"]
    if claimed["attempts"] > pipeline.MAX_ATTEMPTS:
        mark_failed(
            source_id, worker_id, crashed(f"stage {stage} stopped {pipeline.MAX_ATTEMPTS} times"), stage
        )
        return "failed"
    try:
        status = await pipeline.run_source(source_id, worker_id, stop)
        release(source_id, worker_id)
        return status
    except pipeline.WorkerStopping:
        release(source_id, worker_id)
        return None
    except pipeline.LeaseLost:
        return None
    except AncileError as err:
        current, attempts = _status(source_id, stage)
        if err.retryable and attempts < pipeline.MAX_ATTEMPTS:
            log.info("stage will retry", source_id=source_id, stage=current, code=err.code)
            release(source_id, worker_id, RETRY_BACKOFF_S)
            return None
        mark_failed(source_id, worker_id, err, current)
        return "failed"
    except Exception as exc:
        current, attempts = _status(source_id, stage)
        log.exception("stage crashed", source_id=source_id, stage=current)
        if attempts < pipeline.MAX_ATTEMPTS:
            release(source_id, worker_id, RETRY_BACKOFF_S)
            return None
        mark_failed(source_id, worker_id, crashed(type(exc).__name__), current)
        return "failed"


def _status(source_id: str, fallback: str) -> tuple[str, int]:
    """The stage the source reached and how many attempts that stage has had."""
    with sessions().begin() as db:
        row = db.execute(
            text(f"SELECT status, attempts FROM {S}.sources WHERE id = :id"), {"id": source_id}
        ).first()
    return (str(row[0]), int(row[1])) if row else (fallback, pipeline.MAX_ATTEMPTS)


async def drain(worker_id: str | None = None, *, limit: int = 1000) -> int:
    """Process claimable sources until none is left (tests, evals, CLI)."""
    worker_id = worker_id or f"drain-{secrets.token_hex(4)}"
    n = 0
    while n < limit:
        claimed = claim(worker_id)
        if claimed is None:
            break
        await process(claimed, worker_id)
        n += 1
    return n


class Worker:
    """The in-process worker thread. start() and stop() come from the lifespan."""

    def __init__(self) -> None:
        self.id = f"kn-{secrets.token_hex(6)}"
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._next_maintenance = time.monotonic() + 60
        self.running = False

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="knowledge-worker", daemon=True)
        self._thread.start()

    def wake(self) -> None:
        self._wake.set()

    def stop(self, timeout_s: float = 10) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout_s)
            self._thread = None

    def _run(self) -> None:
        # A new thread starts with empty context: bind what every log line carries.
        structlog.contextvars.bind_contextvars(service=SERVICE)
        asyncio.run(self._main())

    async def _main(self) -> None:
        self.running = True
        recovered = False
        while not self._stop.is_set():
            try:
                if not recovered:
                    n = recover_leases()
                    recovered = True
                    if n:
                        log.info("resuming sources", count=n)
                claimed = claim(self.id)
                if claimed is not None:
                    await process(claimed, self.id, self._stop)
                    continue
                if time.monotonic() >= self._next_maintenance:
                    await self._maintenance()
            except Exception:
                # The database may be down; keep the worker alive and try again.
                log.exception("worker loop error")
                self._wake.wait(5)
                self._wake.clear()
                continue
            self._wake.wait(IDLE_POLL_S)
            self._wake.clear()
        self.running = False

    async def _maintenance(self) -> None:
        from .sources import stale

        self._next_maintenance = time.monotonic() + get_settings().stale_check_hours * 3600
        try:
            result = await stale.sweep()
            log.info("stale sweep", **result)
        except Exception:
            log.exception("stale sweep failed")


_worker: Worker | None = None


def get_worker() -> Worker | None:
    return _worker


def start_worker() -> Worker:
    global _worker
    if _worker is None:
        _worker = Worker()
        _worker.start()
    return _worker


def stop_worker() -> None:
    global _worker
    if _worker is not None:
        _worker.stop()
        _worker = None


def wake_worker() -> None:
    if _worker is not None:
        _worker.wake()
