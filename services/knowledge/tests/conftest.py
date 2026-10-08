"""
Test environment: deterministic settings, no real services required.

Integration tests (fixture `kdb`) need Postgres with pgvector. They use a
separate database, never the dev one:
  ANCILE_TEST_DATABASE_URL  if set, used as is;
  else DATABASE_URL         if set (pnpm passes it), with the database name
                            replaced by ancile_kn_test.
The database is created if missing and migrated to head. Without a
reachable server these tests skip with the reason.

Embeddings use the deterministic HashEmbedder unless
ANCILE_TEST_REAL_EMBEDDER=1 (and the fastembed weights are cached); nothing
is ever downloaded during tests.
"""

from __future__ import annotations

import os
import tempfile
from urllib.parse import urlsplit, urlunsplit

TEST_DB_NAME = "ancile_kn_test"


def _test_db_url() -> str | None:
    explicit = os.environ.get("ANCILE_TEST_DATABASE_URL")
    if explicit:
        return explicit
    base = os.environ.get("DATABASE_URL")
    if not base:
        return None
    parts = urlsplit(base)
    return urlunsplit((parts.scheme, parts.netloc, f"/{TEST_DB_NAME}", parts.query, parts.fragment))


TEST_DB_URL = _test_db_url()
if TEST_DB_URL:
    os.environ["DATABASE_URL"] = TEST_DB_URL
else:
    os.environ.setdefault("DATABASE_URL", "postgres://ancile:change-me-locally@localhost:5433/ancile")
os.environ.setdefault("ANCILE_SERVICE_TOKEN", "test-service-token")
os.environ.setdefault("ANCILE_LOG_LEVEL", "warning")
os.environ["KNOWLEDGE_DATA_DIR"] = tempfile.mkdtemp(prefix="ancile-kn-test-")
os.environ["KNOWLEDGE_MODEL_DOWNLOAD"] = "false"
os.environ["KNOWLEDGE_WORKER"] = "false"

import pytest  # noqa: E402

AUTH = {"authorization": "Bearer test-service-token"}

_db_state: dict[str, object] = {}


def _prepare_database() -> str | None:
    """Create, extend and migrate the test database. Returns a skip reason, or None."""
    if not TEST_DB_URL:
        return "No test database: set ANCILE_TEST_DATABASE_URL (or DATABASE_URL) to a Postgres with pgvector."
    import psycopg

    plain = TEST_DB_URL.replace("postgresql+psycopg://", "postgresql://").replace(
        "postgres://", "postgresql://"
    )
    parts = urlsplit(plain)
    admin = urlunsplit((parts.scheme, parts.netloc, "/postgres", parts.query, parts.fragment))
    try:
        with psycopg.connect(admin, connect_timeout=3, autocommit=True) as conn:
            exists = conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (TEST_DB_NAME,)).fetchone()
            if not exists and parts.path.lstrip("/") == TEST_DB_NAME:
                conn.execute(f'CREATE DATABASE "{TEST_DB_NAME}"')
        with psycopg.connect(plain, connect_timeout=3, autocommit=True) as conn:
            conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
            conn.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    except Exception as exc:
        return f"Test Postgres unreachable ({type(exc).__name__}); start it or set ANCILE_TEST_DATABASE_URL."
    from pathlib import Path

    from alembic.config import Config

    from alembic import command

    root = Path(__file__).resolve().parents[1]
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "alembic"))
    command.upgrade(cfg, "head")
    return None


@pytest.fixture(scope="session")
def _migrated() -> None:
    if "reason" not in _db_state:
        _db_state["reason"] = _prepare_database()
    if _db_state["reason"]:
        pytest.skip(str(_db_state["reason"]))


@pytest.fixture
def kdb(_migrated: None):  # type: ignore[no-untyped-def]
    """A clean knowledge schema, the hash embedder, and no reranker."""
    from sqlalchemy import text

    from ancile_knowledge.db import sessions
    from ancile_knowledge.ingest import embed, fetch
    from ancile_knowledge.search import rerank

    with sessions().begin() as db:
        db.execute(text("TRUNCATE knowledge.sources CASCADE"))
    if os.environ.get("ANCILE_TEST_REAL_EMBEDDER") != "1":
        embed.set_embedder(embed.HashEmbedder())
    rerank.set_reranker(rerank.IdentityReranker())
    resolver, transport = fetch.resolve_host, fetch.transport
    yield sessions
    fetch.resolve_host, fetch.transport = resolver, transport
    embed.set_embedder(None)
    rerank.set_reranker(None)


def make_pdf(pages: list[list[str]]) -> bytes:
    """A minimal valid PDF: one Helvetica text line per string, one list per page."""
    objects: list[bytes] = []
    n_pages = len(pages)
    page_ids = [4 + 2 * i for i in range(n_pages)]
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{i} 0 R" for i in page_ids)
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>".encode())
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for i, lines in enumerate(pages):
        content_id = page_ids[i] + 1
        objects.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>"
            ).encode()
        )
        ops = ["BT", "/F1 12 Tf", "72 720 Td", "14 TL"]
        for line in lines:
            escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            ops.append(f"({escaped}) Tj T*")
        ops.append("ET")
        stream = "\n".join(ops).encode("latin-1")
        objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for num, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{num} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def blank_pdf(n: int) -> bytes:
    import io

    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument.new()
    for _ in range(n):
        pdf.new_page(612, 792)
    buf = io.BytesIO()
    pdf.save(buf)
    pdf.close()
    return buf.getvalue()


def add_text_source(ws: str, title: str, body: str, notebooks: dict[str, str] | None = None) -> str:
    """Insert a queued text source (as POST /sources does) and link it to notebooks."""
    from sqlalchemy import text

    from ancile_knowledge.db import sessions
    from ancile_knowledge.sources import repo

    sid = repo.new_id()
    repo.write_atomic(repo.input_path(sid), body)
    with sessions().begin() as db:
        db.execute(
            text(
                "INSERT INTO knowledge.sources "
                "(id, workspace_id, kind, title, status, progress, tags, topics) "
                "VALUES (:id, :ws, 'text', :t, 'queued', '{}', '{}', '{}')"
            ),
            {"id": sid, "ws": ws, "t": title},
        )
        for nb, level in (notebooks or {}).items():
            db.execute(
                text(
                    "INSERT INTO knowledge.notebook_sources (notebook_id, source_id, context_level) "
                    "VALUES (:nb, :id, :lvl)"
                ),
                {"nb": nb, "id": sid, "lvl": level},
            )
    return sid


def drain() -> int:
    import asyncio

    from ancile_knowledge import jobs

    return asyncio.run(jobs.drain())
