"""knowledge schema v5: the switches and options of the built-in automations

- automation_settings: one row, the last KnowledgeAutomations set Core sent
  with PUT /kn/v1/maintenance/automations (packages/contracts/src/ops.ts),
  so a restart of either service keeps them. No row means Core has sent
  nothing yet, and the defaults apply (ancile_knowledge/automations.py).

Revision ID: 0005_automation_settings
Revises: 0004_embed_index
Create Date: 2026-10-14
"""

from alembic import op

revision = "0005_automation_settings"
down_revision = "0004_embed_index"
branch_labels = None
depends_on = None

S = "knowledge"


def upgrade() -> None:
    op.execute(f"""
    CREATE TABLE IF NOT EXISTS {S}.automation_settings (
      id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      settings   jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
      updated_at timestamptz NOT NULL DEFAULT now()
    )""")


def downgrade() -> None:
    op.execute(f"DROP TABLE IF EXISTS {S}.automation_settings")
