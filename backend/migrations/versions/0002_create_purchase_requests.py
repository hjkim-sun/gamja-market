"""create purchase requests

Revision ID: 0002_create_purchase_requests
Revises: 0001_create_auth_tables
Create Date: 2026-09-21
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0002_create_purchase_requests"
down_revision = "0001_create_auth_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "purchase_requests",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("buyer_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.String(length=60), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("category", sa.String(length=30), nullable=False),
        sa.Column("condition", sa.String(length=10), nullable=False),
        sa.Column("price_min", sa.Integer(), nullable=False),
        sa.Column("price_max", sa.Integer(), nullable=False),
        sa.Column("region", sa.String(length=50), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False, server_default=sa.text("'open'")),
        sa.Column("thumbnail_url", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("price_min >= 0 AND price_max >= price_min", name="ck_purchase_requests_price_range"),
        sa.CheckConstraint("price_max <= 1000000000", name="ck_purchase_requests_price_max_bound"),
        sa.CheckConstraint("status IN ('open', 'matched', 'closed')", name="ck_purchase_requests_status"),
        sa.CheckConstraint("condition IN ('any', 'new', 'like_new', 'used')", name="ck_purchase_requests_condition"),
        sa.CheckConstraint("char_length(btrim(title)) BETWEEN 2 AND 60", name="ck_purchase_requests_title_len"),
        sa.CheckConstraint(
            "char_length(btrim(description)) BETWEEN 10 AND 1000",
            name="ck_purchase_requests_description_len",
        ),
        sa.CheckConstraint("updated_at >= created_at", name="ck_purchase_requests_updated_after_created"),
        sa.ForeignKeyConstraint(["buyer_id"], ["app_private.users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        schema="app_private",
    )
    op.create_index(
        "ix_purchase_requests_created_at_id", "purchase_requests", [sa.text("created_at DESC"), sa.text("id DESC")],
        unique=False, schema="app_private",
    )
    op.create_index("ix_purchase_requests_buyer_id", "purchase_requests", ["buyer_id"], unique=False, schema="app_private")
    op.create_index("ix_purchase_requests_category", "purchase_requests", ["category"], unique=False, schema="app_private")
    op.create_index("ix_purchase_requests_status", "purchase_requests", ["status"], unique=False, schema="app_private")


def downgrade() -> None:
    op.drop_index("ix_purchase_requests_status", table_name="purchase_requests", schema="app_private")
    op.drop_index("ix_purchase_requests_category", table_name="purchase_requests", schema="app_private")
    op.drop_index("ix_purchase_requests_buyer_id", table_name="purchase_requests", schema="app_private")
    op.drop_index("ix_purchase_requests_created_at_id", table_name="purchase_requests", schema="app_private")
    op.drop_table("purchase_requests", schema="app_private")
