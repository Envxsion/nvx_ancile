"""
------------------------------------------------------------------
 Title    |  Database: the knowledge schema
 Ref      |  DESIGN.md §3.2
 ID       |  knowledge
------------------------------------------------------------------
 Purpose  |  SQLAlchemy models for everything Knowledge owns. Only
          |  this service writes to schema "knowledge"; Core reads it
          |  through /kn/v1, never directly.
 Note     |  chunk_embeddings.embedding is an untyped pgvector column
          |  so several embedding models can coexist; each model gets
          |  its own partial HNSW index over a cast to its dimension
          |  (see hnsw_index_sql), which is what lets the embedder be
          |  swapped with a background re-embed and no downtime.
------------------------------------------------------------------
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Boolean,
    Computed,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Text,
    create_engine,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, TSVECTOR
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

SCHEMA = "knowledge"


class Base(DeclarativeBase):
    metadata = MetaData(schema=SCHEMA)


def _now() -> Any:
    return func.now()


class Source(Base):
    __tablename__ = "sources"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    workspace_id: Mapped[str] = mapped_column(String, index=True)
    kind: Mapped[str] = mapped_column(String)  # file|url|text|folder|thread|youtube|audio
    title: Mapped[str] = mapped_column(Text)
    uri: Mapped[str | None] = mapped_column(Text)
    mime: Mapped[str | None] = mapped_column(String)
    bytes: Mapped[int | None] = mapped_column(BigInteger)
    content_hash: Mapped[str | None] = mapped_column(String, index=True)
    status: Mapped[str] = mapped_column(String, default="queued")
    progress: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    error: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    topics: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    stale_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    etag: Mapped[str | None] = mapped_column(String)
    last_modified: Mapped[str | None] = mapped_column(String)
    current_version: Mapped[int] = mapped_column(Integer, default=0)
    # 0002: the in-process worker (jobs.py) and staleness.
    pending_version: Mapped[int | None] = mapped_column(Integer)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    lease_owner: Mapped[str | None] = mapped_column(String)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    stale: Mapped[bool] = mapped_column(Boolean, default=False)
    stale_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    title_auto: Mapped[bool] = mapped_column(Boolean, default=False)
    minhash: Mapped[list[int] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=_now(), onupdate=_now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class NotebookSource(Base):
    __tablename__ = "notebook_sources"
    notebook_id: Mapped[str] = mapped_column(String, primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"), primary_key=True)
    context_level: Mapped[str] = mapped_column(String, default="full")  # off|insights|full
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now())


class SourceVersion(Base):
    __tablename__ = "source_versions"
    source_id: Mapped[str] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    markdown_path: Mapped[str] = mapped_column(Text)
    extractor: Mapped[str] = mapped_column(String)
    extracted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now())
    content_hash: Mapped[str] = mapped_column(String)
    pages: Mapped[list[dict[str, int]]] = mapped_column(JSONB, default=list)
    chars: Mapped[int | None] = mapped_column(Integer)


class Chunk(Base):
    __tablename__ = "chunks"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    ordinal: Mapped[int] = mapped_column(Integer)
    parent_id: Mapped[str | None] = mapped_column(String)
    text: Mapped[str] = mapped_column(Text)
    context_blurb: Mapped[str | None] = mapped_column(Text)
    heading_path: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    page: Mapped[int | None] = mapped_column(Integer)
    char_start: Mapped[int] = mapped_column(Integer)
    char_end: Mapped[int] = mapped_column(Integer)
    bbox: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    tokens: Mapped[int] = mapped_column(Integer)
    # Blurb + text, so BM25-style matching benefits from contextual enrichment too.
    tsv: Mapped[Any] = mapped_column(
        TSVECTOR,
        Computed("to_tsvector('english', coalesce(context_blurb, '') || ' ' || text)", persisted=True),
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now())

    __table_args__ = (
        Index("chunks_tsv_gin", "tsv", postgresql_using="gin"),
        Index("chunks_source_version_ordinal", "source_id", "version", "ordinal", unique=True),
    )


class ChunkEmbedding(Base):
    __tablename__ = "chunk_embeddings"
    chunk_id: Mapped[str] = mapped_column(ForeignKey("chunks.id", ondelete="CASCADE"), primary_key=True)
    model_key: Mapped[str] = mapped_column(String, primary_key=True)
    embedding: Mapped[Any] = mapped_column(Vector())


class Insight(Base):
    __tablename__ = "insights"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"), index=True)
    transformation_id: Mapped[str] = mapped_column(String)
    content_md: Mapped[str] = mapped_column(Text)
    model_id: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now())


class Transformation(Base):
    __tablename__ = "transformations"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, unique=True)
    prompt_path: Mapped[str] = mapped_column(Text)
    apply_on_ingest: Mapped[bool] = mapped_column(Boolean, default=False)
    model_task_class: Mapped[str] = mapped_column(String, default="utility")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now())


class SourceRelation(Base):
    __tablename__ = "source_relations"
    a_id: Mapped[str] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"), primary_key=True)
    b_id: Mapped[str] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"), primary_key=True)
    kind: Mapped[str] = mapped_column(String)  # duplicate|near_duplicate|new_version
    score: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String, default="suggested")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=_now())


# --- Per-model vector indexes -------------------------------------------------

_MODEL_KEY = re.compile(r"^[A-Za-z0-9._/-]{1,120}$")


def index_name_for(model_key: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", model_key.lower()).strip("_")[:40]
    return f"chunk_emb_hnsw_{slug}"


def hnsw_index_sql(model_key: str, dim: int) -> str:
    """
    The partial-index pattern: one HNSW index per embedding model over a cast
    to that model's dimension. Queries must use the same cast and predicate:

        ORDER BY embedding::vector(384) <=> :q  ... WHERE model_key = :key
    """
    if not _MODEL_KEY.match(model_key):
        raise ValueError(f"unsafe model key: {model_key!r}")
    if not 1 <= dim <= 16000:
        raise ValueError(f"unsupported dimension: {dim}")
    literal = model_key.replace("'", "''")
    return (
        f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {index_name_for(model_key)} "
        f"ON {SCHEMA}.chunk_embeddings USING hnsw ((embedding::vector({dim})) vector_cosine_ops) "
        f"WHERE model_key = '{literal}'"
    )


_engine: Engine | None = None


def get_engine(url: str) -> Engine:
    global _engine
    if _engine is None:
        # connect_timeout: a down database must fail /ready in seconds, not hang it.
        _engine = create_engine(
            url, pool_pre_ping=True, pool_size=5, max_overflow=5, connect_args={"connect_timeout": 3}
        )
    return _engine


def session_factory(url: str) -> sessionmaker[Any]:
    return sessionmaker(get_engine(url), expire_on_commit=False)


_sessions: sessionmaker[Any] | None = None


def sessions() -> sessionmaker[Any]:
    """The process-wide session factory for the configured database."""
    global _sessions
    if _sessions is None:
        from .settings import get_settings

        _sessions = session_factory(get_settings().sqlalchemy_url)
    return _sessions


def reset_engine() -> None:
    """Drop pooled connections (tests switch databases; shutdown frees them)."""
    global _engine, _sessions
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _sessions = None
