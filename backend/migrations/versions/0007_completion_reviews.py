"""Add irreversible transaction completion and review storage.

Revision ID: 0007_completion_reviews
Revises: 0006_security_perf_hardening
"""

from alembic import op
import sqlalchemy as sa

revision = "0007_completion_reviews"
down_revision = "0006_security_perf_hardening"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(sa.text("SET LOCAL lock_timeout = '5s'"))
    op.execute(sa.text(
        "ALTER TABLE app_private.purchase_requests ADD COLUMN IF NOT EXISTS completed_at timestamptz"
    ))
    # Replace the status CHECK atomically only when the allowed set is missing completed.
    op.execute(sa.text("""
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint c
             WHERE c.conname = 'ck_purchase_requests_status'
               AND c.conrelid = to_regclass('app_private.purchase_requests')
               AND position('completed' in pg_get_constraintdef(c.oid)) > 0
          ) THEN
            ALTER TABLE app_private.purchase_requests DROP CONSTRAINT IF EXISTS ck_purchase_requests_status;
            ALTER TABLE app_private.purchase_requests ADD CONSTRAINT ck_purchase_requests_status
              CHECK (status IN ('open', 'matched', 'closed', 'completed'));
          END IF;
        END $$
    """))
    op.execute(sa.text("""
        DO $$ BEGIN
          ALTER TABLE app_private.purchase_requests ADD CONSTRAINT ck_purchase_requests_completed_at
            CHECK ((status = 'completed') = (completed_at IS NOT NULL));
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
    """))
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS app_private.reviews (
          id uuid PRIMARY KEY,
          request_id uuid NOT NULL,
          reviewer_id uuid NOT NULL,
          reviewee_id uuid NOT NULL,
          reviewer_role varchar(6) NOT NULL,
          rating smallint NOT NULL,
          body text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT fk_reviews_request FOREIGN KEY (request_id)
            REFERENCES app_private.purchase_requests(id) ON DELETE CASCADE,
          CONSTRAINT fk_reviews_reviewer FOREIGN KEY (reviewer_id)
            REFERENCES app_private.users(id) ON DELETE CASCADE,
          CONSTRAINT fk_reviews_reviewee FOREIGN KEY (reviewee_id)
            REFERENCES app_private.users(id) ON DELETE CASCADE,
          CONSTRAINT uq_reviews_request_reviewer UNIQUE (request_id, reviewer_id),
          CONSTRAINT uq_reviews_request_role UNIQUE (request_id, reviewer_role),
          CONSTRAINT ck_reviews_role CHECK (reviewer_role IN ('buyer', 'seller')),
          CONSTRAINT ck_reviews_not_self CHECK (reviewer_id <> reviewee_id),
          CONSTRAINT ck_reviews_rating CHECK (rating BETWEEN 1 AND 5),
          CONSTRAINT ck_reviews_body_len CHECK (char_length(btrim(body)) BETWEEN 2 AND 500)
        )
    """))
    op.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_reviews_reviewee_id ON app_private.reviews (reviewee_id)"))
    op.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_reviews_reviewer_id ON app_private.reviews (reviewer_id)"))


def downgrade() -> None:
    raise RuntimeError("0007_completion_reviews is irreversible; restore using a forward migration")
