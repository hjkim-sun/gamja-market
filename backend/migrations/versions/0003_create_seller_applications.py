"""create seller applications and chat rooms

Revision ID: 0003_seller_applications
Revises: 0002_create_purchase_requests
Create Date: 2026-09-26
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0003_seller_applications"
down_revision = "0002_create_purchase_requests"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint(
        "uq_purchase_requests_id_buyer",
        "purchase_requests",
        ["id", "buyer_id"],
        schema="app_private",
    )
    op.create_table(
        "seller_applications",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("request_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("buyer_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("seller_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("offer_price", sa.Integer(), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.CheckConstraint("seller_id <> buyer_id", name="ck_seller_applications_not_self"),
        sa.CheckConstraint("offer_price BETWEEN 0 AND 1000000000", name="ck_seller_applications_offer_price"),
        sa.CheckConstraint(
            "char_length(btrim(message)) BETWEEN 2 AND 500", name="ck_seller_applications_message_len"
        ),
        sa.ForeignKeyConstraint(
            ["request_id", "buyer_id"],
            ["app_private.purchase_requests.id", "app_private.purchase_requests.buyer_id"],
            name="fk_seller_applications_request_buyer",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["seller_id"], ["app_private.users.id"], name="fk_seller_applications_seller", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("request_id", "seller_id", name="uq_seller_applications_request_seller"),
        schema="app_private",
    )
    op.create_index(
        "ix_seller_applications_request_created",
        "seller_applications",
        ["request_id", "created_at", "id"],
        unique=False,
        schema="app_private",
    )
    op.create_index(
        "ix_seller_applications_seller_id",
        "seller_applications",
        ["seller_id"],
        unique=False,
        schema="app_private",
    )
    op.create_table(
        "chat_rooms",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("application_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(
            ["application_id"],
            ["app_private.seller_applications.id"],
            name="fk_chat_rooms_application",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("application_id", name="uq_chat_rooms_application"),
        schema="app_private",
    )


def downgrade() -> None:
    op.drop_table("chat_rooms", schema="app_private")
    op.drop_index("ix_seller_applications_seller_id", table_name="seller_applications", schema="app_private")
    op.drop_index("ix_seller_applications_request_created", table_name="seller_applications", schema="app_private")
    op.drop_table("seller_applications", schema="app_private")
    op.drop_constraint(
        "uq_purchase_requests_id_buyer", "purchase_requests", schema="app_private", type_="unique"
    )
