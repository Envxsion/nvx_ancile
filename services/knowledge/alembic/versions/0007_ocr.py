"""knowledge schema v7: OCR for scanned PDFs (ROADMAP SR1)

- ocr_settings: one row, the last {enabled, language} Core sent with
  PUT /kn/v1/maintenance/ocr (Settings -> Sources), so a restart of either
  service keeps them. No row means Core has sent nothing yet: OCR is off.
- sources.ocr: this one source asks for OCR whatever the setting says
  ("Read with OCR" on a failed source card).

Revision ID: 0007_ocr
Revises: 0006_source_metadata
Create Date: 2026-10-19
"""

from alembic import op

revision = "0007_ocr"
down_revision = "0006_source_metadata"
branch_labels = None
depends_on = None

S = "knowledge"


def upgrade() -> None:
    op.execute(f"""
    CREATE TABLE IF NOT EXISTS {S}.ocr_settings (
      id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      settings   jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
      updated_at timestamptz NOT NULL DEFAULT now()
    )""")
    op.execute(f"ALTER TABLE {S}.sources ADD COLUMN IF NOT EXISTS ocr boolean NOT NULL DEFAULT false")


def downgrade() -> None:
    op.execute(f"ALTER TABLE {S}.sources DROP COLUMN IF EXISTS ocr")
    op.execute(f"DROP TABLE IF EXISTS {S}.ocr_settings")
