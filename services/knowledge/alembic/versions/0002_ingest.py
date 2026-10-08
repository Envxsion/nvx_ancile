"""knowledge schema v2: ingestion worker, page spans, staleness (ROADMAP Phase 3)

- sources: lease columns for the in-process worker (jobs.py), the version
  being built (pending_version), a stale flag, the MinHash signature for
  duplicate detection, and whether the title was chosen by Ancile.
- source_versions: page spans (PDF) and the extracted size.
- transformations: the built-in extractive summary, so insights can point
  at it (insights.transformation_id is a foreign key).

Revision ID: 0002_ingest
Revises: 0001_init
Create Date: 2026-10-07
"""

from alembic import op

revision = "0002_ingest"
down_revision = "0001_init"
branch_labels = None
depends_on = None

S = "knowledge"


def upgrade() -> None:
    op.execute(f"""
    ALTER TABLE {S}.sources
      ADD COLUMN IF NOT EXISTS pending_version  integer,
      ADD COLUMN IF NOT EXISTS attempts         integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS lease_owner      text,
      ADD COLUMN IF NOT EXISTS lease_until      timestamptz,
      ADD COLUMN IF NOT EXISTS stale            boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS stale_checked_at timestamptz,
      ADD COLUMN IF NOT EXISTS title_auto       boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS minhash          jsonb
    """)
    # The worker's claim query: unfinished, not deleted, oldest first.
    op.execute(f"""
    CREATE INDEX IF NOT EXISTS sources_work ON {S}.sources (updated_at)
      WHERE deleted_at IS NULL AND status IN ('queued','extracting','enriching','embedding')
    """)
    op.execute(f"CREATE INDEX IF NOT EXISTS source_relations_b ON {S}.source_relations (b_id)")
    op.execute(f"CREATE INDEX IF NOT EXISTS chunks_parent ON {S}.chunks (parent_id)")

    op.execute(f"""
    ALTER TABLE {S}.source_versions
      ADD COLUMN IF NOT EXISTS pages jsonb NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS chars integer
    """)

    op.execute(f"""
    INSERT INTO {S}.transformations (id, name, prompt_path, apply_on_ingest, model_task_class)
    VALUES ('summary', 'Summary', 'builtin:extractive', true, 'utility')
    ON CONFLICT (id) DO NOTHING
    """)


def downgrade() -> None:
    op.execute(f"DELETE FROM {S}.insights WHERE transformation_id = 'summary'")
    op.execute(f"DELETE FROM {S}.transformations WHERE id = 'summary'")
    op.execute(f"ALTER TABLE {S}.source_versions DROP COLUMN IF EXISTS pages, DROP COLUMN IF EXISTS chars")
    op.execute(f"DROP INDEX IF EXISTS {S}.chunks_parent")
    op.execute(f"DROP INDEX IF EXISTS {S}.source_relations_b")
    op.execute(f"DROP INDEX IF EXISTS {S}.sources_work")
    op.execute(f"""
    ALTER TABLE {S}.sources
      DROP COLUMN IF EXISTS pending_version, DROP COLUMN IF EXISTS attempts,
      DROP COLUMN IF EXISTS lease_owner, DROP COLUMN IF EXISTS lease_until,
      DROP COLUMN IF EXISTS stale, DROP COLUMN IF EXISTS stale_checked_at,
      DROP COLUMN IF EXISTS title_auto, DROP COLUMN IF EXISTS minhash
    """)
