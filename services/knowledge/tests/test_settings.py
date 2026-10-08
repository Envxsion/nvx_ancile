"""Blank path settings in .env mean "use the default", not the working directory."""

from pathlib import Path

from ancile_knowledge.settings import Settings


def test_blank_knowledge_dir_falls_back_to_data_dir(monkeypatch):
    monkeypatch.setenv("KNOWLEDGE_DATA_DIR", "")
    monkeypatch.setenv("KNOWLEDGE_MODEL_CACHE", "  ")
    s = Settings(DATABASE_URL="postgres://x@localhost/db", ANCILE_DATA_DIR="/srv/ancile")
    assert s.storage_dir == Path("/srv/ancile") / "knowledge"
    assert s.model_cache == Path("/srv/ancile") / "models"
