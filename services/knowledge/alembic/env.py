"""Alembic environment: migrates schema "knowledge" only (DESIGN.md §3)."""

from __future__ import annotations

from sqlalchemy import create_engine, text

from alembic import context
from ancile_knowledge.db import SCHEMA, Base
from ancile_knowledge.settings import get_settings

target_metadata = Base.metadata


def run_migrations_online() -> None:
    engine = create_engine(get_settings().sqlalchemy_url)
    with engine.connect() as conn:
        conn.execute(text(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}"))
        conn.commit()
        context.configure(
            connection=conn,
            target_metadata=target_metadata,
            version_table_schema=SCHEMA,
            include_schemas=True,
            include_name=lambda name, type_, _parent: type_ != "schema" or name == SCHEMA,
        )
        with context.begin_transaction():
            context.run_migrations()


def run_migrations_offline() -> None:
    context.configure(
        url=get_settings().sqlalchemy_url,
        target_metadata=target_metadata,
        literal_binds=True,
        version_table_schema=SCHEMA,
    )
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
