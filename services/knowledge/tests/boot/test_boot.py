"""
Boot suite (DESIGN.md §14): fast checks run before Knowledge accepts traffic.
Each failure says what is wrong and how to fix it; scripts/boot.mjs prints
them verbatim. Run: uv run pytest -m boot

Embedder and database checks skip with their fix when the dependency is
absent, unless ANCILE_BOOT_REQUIRE_EMBED=1 / ANCILE_BOOT_REQUIRE_DB=1, which
the boot runner sets when starting the real stack.
"""

import os

import pytest

from ancile_knowledge.db import hnsw_index_sql
from ancile_knowledge.health import check_db, check_embedder
from ancile_knowledge.settings import get_settings

pytestmark = pytest.mark.boot


def test_settings_parse():
    s = get_settings()
    assert s.chunk_overlap < s.chunk_tokens


def test_vector_index_helper_rejects_unsafe_keys():
    assert "vector(384)" in hnsw_index_sql("local/BAAI/bge-small-en-v1.5", 384)
    with pytest.raises(ValueError):
        hnsw_index_sql("x'; drop table y; --", 384)


def test_embedder_installed():
    c = check_embedder()
    if not c.ok and os.environ.get("ANCILE_BOOT_REQUIRE_EMBED") != "1":
        pytest.skip(f"{c.detail} Fix: {c.fix}")
    assert c.ok, f"{c.detail} Fix: {c.fix}"


def test_database_reachable():
    c = check_db()
    if not c.ok and os.environ.get("ANCILE_BOOT_REQUIRE_DB") != "1":
        pytest.skip(f"{c.detail} Fix: {c.fix}")
    assert c.ok, f"{c.detail} Fix: {c.fix}"
