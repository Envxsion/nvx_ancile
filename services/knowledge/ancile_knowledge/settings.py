"""
------------------------------------------------------------------
 Title    |  Knowledge settings
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  Every environment variable, validated once at boot.
 How      |  pydantic-settings. A bad value raises SettingsError with
          |  the variable name and the fix, which the boot runner
          |  prints verbatim instead of a traceback.
------------------------------------------------------------------
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class SettingsError(RuntimeError):
    """Readable configuration failure: what is wrong and how to fix it."""


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", protected_namespaces=("settings_",)
    )

    database_url: str = Field(alias="DATABASE_URL")
    service_token: str = Field(default="", alias="ANCILE_SERVICE_TOKEN")
    core_internal_url: str = Field(default="http://localhost:7700/internal/v1", alias="CORE_INTERNAL_URL")
    port: int = Field(default=7710, alias="KNOWLEDGE_PORT")
    log_level: str = Field(default="info", alias="ANCILE_LOG_LEVEL")
    data_dir: Path = Field(default=Path("./data"), alias="ANCILE_DATA_DIR")

    embed_model: str = Field(default="BAAI/bge-small-en-v1.5", alias="KNOWLEDGE_EMBED_MODEL")
    # A cross-encoder fastembed ships (bge-reranker-v2-m3 is not one of them).
    rerank_model: str = Field(default="Xenova/ms-marco-MiniLM-L-6-v2", alias="KNOWLEDGE_RERANK_MODEL")
    # Empty means <data dir>/models.
    model_cache_dir: Path | None = Field(default=None, alias="KNOWLEDGE_MODEL_CACHE")
    # Ingestion may download embedder weights on first use; search never does.
    model_download: bool = Field(default=True, alias="KNOWLEDGE_MODEL_DOWNLOAD")
    embed_batch: int = Field(default=64, alias="KNOWLEDGE_EMBED_BATCH", ge=1, le=1024)
    use_docling: bool = Field(default=True, alias="KNOWLEDGE_USE_DOCLING")
    ocr: bool = Field(default=False, alias="KNOWLEDGE_OCR")
    chunk_tokens: int = Field(default=512, alias="KNOWLEDGE_CHUNK_TOKENS", ge=64, le=4096)
    chunk_overlap: int = Field(default=64, alias="KNOWLEDGE_CHUNK_OVERLAP", ge=0)
    contextual_chunks: bool = Field(default=True, alias="KNOWLEDGE_CONTEXTUAL_CHUNKS")
    searxng_url: str = Field(default="", alias="SEARXNG_URL")

    # Originals, extracted markdown. Empty means <ANCILE_DATA_DIR>/knowledge.
    knowledge_dir: Path | None = Field(default=None, alias="KNOWLEDGE_DATA_DIR")
    max_upload_mb: int = Field(default=200, alias="KNOWLEDGE_MAX_UPLOAD_MB", ge=1, le=10_000)
    max_fetch_mb: int = Field(default=50, alias="KNOWLEDGE_MAX_FETCH_MB", ge=1, le=1_000)
    # Off by default: a URL source must not reach the local network (SSRF).
    allow_private_urls: bool = Field(default=False, alias="KNOWLEDGE_ALLOW_PRIVATE_URLS")
    # The in-process ingestion worker (jobs.py). Tests switch it off.
    worker_enabled: bool = Field(default=True, alias="KNOWLEDGE_WORKER")
    stale_check_hours: float = Field(default=6, alias="KNOWLEDGE_STALE_CHECK_HOURS", gt=0)

    @field_validator("model_cache_dir", "knowledge_dir", mode="before")
    @classmethod
    def _blank_is_unset(cls, v: object) -> object:
        # `KNOWLEDGE_DATA_DIR=` in .env arrives as "", which Path reads as the
        # working directory: sources would land in the repository root.
        return None if isinstance(v, str) and not v.strip() else v

    @field_validator("database_url")
    @classmethod
    def _postgres(cls, v: str) -> str:
        if not v.startswith(("postgres://", "postgresql://", "postgresql+psycopg://")):
            raise ValueError("must be a postgres:// URL")
        return v

    @property
    def storage_dir(self) -> Path:
        return self.knowledge_dir or (self.data_dir / "knowledge")

    @property
    def model_cache(self) -> Path:
        return self.model_cache_dir or (self.data_dir / "models")

    @property
    def sqlalchemy_url(self) -> str:
        url = self.database_url
        for prefix in ("postgres://", "postgresql://"):
            if url.startswith(prefix):
                return "postgresql+psycopg://" + url[len(prefix) :]
        return url


_FIXES = {
    "DATABASE_URL": "Set DATABASE_URL in .env, e.g. postgres://ancile:change-me-locally@localhost:5433/ancile",
    "KNOWLEDGE_CHUNK_TOKENS": "Use a value between 64 and 4096 (512 is the default).",
}


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    try:
        s = Settings()
    except ValidationError as exc:
        lines = []
        for err in exc.errors():
            name = str(err["loc"][0]) if err["loc"] else "?"
            fix = _FIXES.get(name, "See .env.example for the expected format.")
            lines.append(f"  {name}: {err['msg']}. {fix}")
        raise SettingsError("Knowledge configuration is invalid:\n" + "\n".join(lines)) from None
    if s.chunk_overlap >= s.chunk_tokens:
        raise SettingsError(
            "Knowledge configuration is invalid:\n  KNOWLEDGE_CHUNK_OVERLAP must be smaller than "
            "KNOWLEDGE_CHUNK_TOKENS."
        )
    return s
