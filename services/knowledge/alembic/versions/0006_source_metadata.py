"""knowledge schema v6: a source's author and date, and a language set by hand (ROADMAP S6)

- sources.author: who wrote it, as the person typed it; NULL when unknown.
- sources.published_on: the date it was published, a plain date; NULL when unknown.
- sources.language_edited: the language was set by hand, so a later fetch
  or re-extraction must not overwrite it with a guess.

Revision ID: 0006_source_metadata
Revises: 0005_automation_settings
Create Date: 2026-10-19
"""

from alembic import op

revision = "0006_source_metadata"
down_revision = "0005_automation_settings"
branch_labels = None
depends_on = None

S = "knowledge"


def upgrade() -> None:
    op.execute(f"ALTER TABLE {S}.sources ADD COLUMN IF NOT EXISTS author text")
    op.execute(f"ALTER TABLE {S}.sources ADD COLUMN IF NOT EXISTS published_on date")
    op.execute(f"ALTER TABLE {S}.sources ADD COLUMN IF NOT EXISTS language_edited boolean NOT NULL DEFAULT false")


def downgrade() -> None:
    op.execute(f"ALTER TABLE {S}.sources DROP COLUMN IF EXISTS language_edited")
    op.execute(f"ALTER TABLE {S}.sources DROP COLUMN IF EXISTS published_on")
    op.execute(f"ALTER TABLE {S}.sources DROP COLUMN IF EXISTS author")
