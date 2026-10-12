"""knowledge schema v3: each source's language (ROADMAP track G)

- sources.language: ISO 639-1 code of the main language of the extracted
  text, detected at ingest (sources/language.py); NULL until detected, or
  when the text is too short to tell.

Revision ID: 0003_source_language
Revises: 0002_ingest
Create Date: 2026-10-12
"""

from alembic import op

revision = "0003_source_language"
down_revision = "0002_ingest"
branch_labels = None
depends_on = None

S = "knowledge"


def upgrade() -> None:
    op.execute(f"ALTER TABLE {S}.sources ADD COLUMN IF NOT EXISTS language text")


def downgrade() -> None:
    op.execute(f"ALTER TABLE {S}.sources DROP COLUMN IF EXISTS language")
