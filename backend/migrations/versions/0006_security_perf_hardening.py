"""Add rate limit storage and query indexes (additive, idempotent).

Revision ID: 0006_security_perf_hardening
Revises: 0005_chat_matching
"""

from alembic import op
import sqlalchemy as sa

revision = "0006_security_perf_hardening"
down_revision = "0005_chat_matching"
branch_labels = None
depends_on = None


def upgrade() -> None:
    statements = [
        """CREATE TABLE IF NOT EXISTS app_private.auth_rate_limits (
          bucket_key char(64) PRIMARY KEY,
          window_started_at timestamptz NOT NULL,
          hit_count integer NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT ck_auth_rate_limits_hit_count CHECK (hit_count >= 1)
        )""",
        "CREATE INDEX IF NOT EXISTS ix_auth_rate_limits_updated_at ON app_private.auth_rate_limits (updated_at)",
        "CREATE INDEX IF NOT EXISTS ix_seller_applications_buyer_id ON app_private.seller_applications (buyer_id)",
        "CREATE INDEX IF NOT EXISTS ix_purchase_requests_price_created_id ON app_private.purchase_requests (price_max DESC, created_at DESC, id DESC)",
    ]
    for statement in statements:
        op.execute(sa.text(statement))


def downgrade() -> None:
    op.execute(sa.text("DROP INDEX IF EXISTS app_private.ix_purchase_requests_price_created_id"))
    op.execute(sa.text("DROP INDEX IF EXISTS app_private.ix_seller_applications_buyer_id"))
    op.execute(sa.text("DROP INDEX IF EXISTS app_private.ix_auth_rate_limits_updated_at"))
    op.execute(sa.text("DROP TABLE IF EXISTS app_private.auth_rate_limits"))
