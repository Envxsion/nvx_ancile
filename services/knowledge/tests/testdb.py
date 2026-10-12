"""
------------------------------------------------------------------
 Title    |  The test database: created, extended and migrated
 Ref      |  tests/conftest.py · tests/eval/retrieval/run.py
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  One place that makes the throwaway database the pytest
          |  suite and the evals use (ancile_kn_test), never the dev
          |  one, so both prepare it the same way.
 How      |  Connects to the server's postgres database, creates
          |  ancile_kn_test when the URL names it and it is missing,
          |  adds pgvector and pg_trgm, then runs Alembic to head.
------------------------------------------------------------------
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

TEST_DB_NAME = "ancile_kn_test"


def db_url_for_tests(explicit: str | None, base: str | None) -> str | None:
    """ANCILE_TEST_DATABASE_URL as is, else DATABASE_URL renamed to ancile_kn_test."""
    if explicit:
        return explicit
    if not base:
        return None
    p = urlsplit(base)
    return urlunsplit((p.scheme, p.netloc, f"/{TEST_DB_NAME}", p.query, p.fragment))


def prepare_test_database(url: str | None) -> str | None:
    """Create, extend and migrate the test database. Returns a reason it could not, or None."""
    if not url:
        return "No test database: set ANCILE_TEST_DATABASE_URL (or DATABASE_URL) to a Postgres with pgvector."
    import psycopg

    plain = url.replace("postgresql+psycopg://", "postgresql://").replace("postgres://", "postgresql://")
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
    from alembic.config import Config

    from alembic import command

    root = Path(__file__).resolve().parents[1]
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "alembic"))
    command.upgrade(cfg, "head")
    return None
