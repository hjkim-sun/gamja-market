"""create authentication tables

Revision ID: 0001_create_auth_tables
Revises:
Create Date: 2026-09-10
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0001_create_auth_tables"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS app_private")
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("email", sa.String(length=254), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("email = lower(btrim(email))", name="ck_users_email_normalized"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("email", name="uq_users_email"),
        schema="app_private",
    )
    op.create_table(
        "auth_sessions",
        sa.Column("token_hash", sa.CHAR(length=64), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("expires_at > created_at", name="ck_auth_sessions_expiry_after_created"),
        sa.ForeignKeyConstraint(["user_id"], ["app_private.users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("token_hash"),
        schema="app_private",
    )
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"], unique=False, schema="app_private")
    op.create_index("ix_auth_sessions_expires_at", "auth_sessions", ["expires_at"], unique=False, schema="app_private")


def downgrade() -> None:
    op.drop_index("ix_auth_sessions_expires_at", table_name="auth_sessions", schema="app_private")
    op.drop_index("ix_auth_sessions_user_id", table_name="auth_sessions", schema="app_private")
    op.drop_table("auth_sessions", schema="app_private")
    op.drop_table("users", schema="app_private")
    op.execute("DROP SCHEMA IF EXISTS app_private")
