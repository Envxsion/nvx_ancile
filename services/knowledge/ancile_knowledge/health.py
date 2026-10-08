"""
------------------------------------------------------------------
 Title    |  Health, readiness, self-test
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  /health  the process is alive (never touches the DB)
          |  /ready   it can serve: DB reachable, schema present
          |  /selftest the boot checks again, on demand, for the
          |           self-diagnostic panel (DESIGN.md §14)
 How      |  Each check returns {name, ok, ms, detail, fix}; the fix
          |  is what the diagnostic panel shows beside a failure.
------------------------------------------------------------------
"""

from __future__ import annotations

import shutil
import time
from dataclasses import asdict, dataclass

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from . import __version__
from .db import get_engine
from .ingest.embed import fastembed_available
from .settings import get_settings

router = APIRouter()


@dataclass
class Check:
    name: str
    ok: bool
    ms: float
    detail: str
    fix: str | None = None


def check_db() -> Check:
    t = time.perf_counter()
    try:
        with get_engine(get_settings().sqlalchemy_url).connect() as conn:
            has_schema = conn.execute(
                text("select 1 from information_schema.schemata where schema_name = 'knowledge'")
            ).scalar()
            has_vector = conn.execute(text("select 1 from pg_extension where extname = 'vector'")).scalar()
    except Exception as exc:
        return Check(
            "database",
            False,
            _ms(t),
            f"Cannot reach Postgres: {type(exc).__name__}",
            "Start it with `docker compose up -d postgres` and check DATABASE_URL.",
        )
    if not has_vector:
        return Check(
            "database",
            False,
            _ms(t),
            "The pgvector extension is missing.",
            "Use the pgvector/pgvector image, or run CREATE EXTENSION vector.",
        )
    if not has_schema:
        return Check(
            "database",
            False,
            _ms(t),
            "The knowledge schema has not been created.",
            "Run `uv run alembic upgrade head` in services/knowledge.",
        )
    return Check("database", True, _ms(t), "Connected; pgvector and schema present.")


def check_embedder() -> Check:
    t = time.perf_counter()
    if fastembed_available():
        return Check("embedder", True, _ms(t), f"fastembed installed ({get_settings().embed_model}).")
    return Check(
        "embedder",
        False,
        _ms(t),
        "The local embedder (fastembed) is not installed.",
        "Run `uv sync --extra embed`, or use the Docker image.",
    )


def check_disk() -> Check:
    t = time.perf_counter()
    data_dir = get_settings().data_dir
    data_dir.mkdir(parents=True, exist_ok=True)
    free_gb = shutil.disk_usage(data_dir).free / 1e9
    ok = free_gb >= 2
    return Check(
        "disk",
        ok,
        _ms(t),
        f"{free_gb:.1f} GB free in {data_dir}.",
        None if ok else "Free some space: ingestion stores originals and extracted text.",
    )


def _ms(t: float) -> float:
    return round((time.perf_counter() - t) * 1000, 1)


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "knowledge", "version": __version__}


@router.get("/ready")
def ready() -> JSONResponse:
    db = check_db()
    return JSONResponse({"ready": db.ok, "checks": [asdict(db)]}, status_code=200 if db.ok else 503)


@router.get("/selftest")
def selftest() -> dict[str, object]:
    checks = [check_db(), check_embedder(), check_disk()]
    return {"ok": all(c.ok for c in checks), "checks": [asdict(c) for c in checks]}
