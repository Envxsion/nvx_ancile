"""knowledge schema v3: which embedding model search uses, and the re-embed job

- embed_index: one row. active_model_key is the model whose vectors search
  reads; target_model_key is the model a background re-embed is filling.
  Search keeps reading the active model's vectors until every current chunk
  has a target vector, then the two swap in one update (ingest/reembed.py).
  Progress (total, done) is recounted from chunk_embeddings, so a restart
  resumes where the last process stopped.

Revision ID: 0004_embed_index
Revises: 0003_source_language
Create Date: 2026-10-12
"""

from alembic import op

revision = "0004_embed_index"
down_revision = "0003_source_language"
branch_labels = None
depends_on = None

S = "knowledge"


def upgrade() -> None:
    op.execute(f"""
    CREATE TABLE IF NOT EXISTS {S}.embed_index (
      id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      active_model_key text,
      target_model_key text,
      status           text NOT NULL DEFAULT 'idle'
                       CHECK (status IN ('idle','running','failed')),
      total            integer NOT NULL DEFAULT 0,
      done             integer NOT NULL DEFAULT 0,
      error            jsonb,
      started_at       timestamptz,
      finished_at      timestamptz,
      updated_at       timestamptz NOT NULL DEFAULT now()
    )""")
    op.execute(f"INSERT INTO {S}.embed_index (id) VALUES (1) ON CONFLICT (id) DO NOTHING")
    # "Which current chunks still lack a vector for this model?"
    op.execute(f"CREATE INDEX IF NOT EXISTS chunk_embeddings_model ON {S}.chunk_embeddings (model_key)")


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {S}.chunk_embeddings_model")
    op.execute(f"DROP TABLE IF EXISTS {S}.embed_index")
