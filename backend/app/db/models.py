from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    CHAR,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("email = lower(btrim(email))", name="ck_users_email_normalized"),
        UniqueConstraint("email", name="uq_users_email"),
        {"schema": "app_private"},
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(254), nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=text("now()"))


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    __table_args__ = (
        CheckConstraint("expires_at > created_at", name="ck_auth_sessions_expiry_after_created"),
        Index("ix_auth_sessions_user_id", "user_id"),
        Index("ix_auth_sessions_expires_at", "expires_at"),
        {"schema": "app_private"},
    )

    token_hash: Mapped[str] = mapped_column(CHAR(64), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("app_private.users.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=text("now()"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class PurchaseRequest(Base):
    __tablename__ = "purchase_requests"
    __table_args__ = (
        CheckConstraint("price_min >= 0 AND price_max >= price_min", name="ck_purchase_requests_price_range"),
        CheckConstraint("price_max <= 1000000000", name="ck_purchase_requests_price_max_bound"),
        CheckConstraint("status IN ('open', 'matched', 'closed')", name="ck_purchase_requests_status"),
        CheckConstraint("condition IN ('any', 'new', 'like_new', 'used')", name="ck_purchase_requests_condition"),
        CheckConstraint("char_length(btrim(title)) BETWEEN 2 AND 60", name="ck_purchase_requests_title_len"),
        CheckConstraint(
            "char_length(btrim(description)) BETWEEN 10 AND 1000",
            name="ck_purchase_requests_description_len",
        ),
        CheckConstraint("updated_at >= created_at", name="ck_purchase_requests_updated_after_created"),
        Index("ix_purchase_requests_created_at_id", text("created_at DESC"), text("id DESC")),
        Index("ix_purchase_requests_buyer_id", "buyer_id"),
        Index("ix_purchase_requests_category", "category"),
        Index("ix_purchase_requests_status", "status"),
        UniqueConstraint("id", "buyer_id", name="uq_purchase_requests_id_buyer"),
        {"schema": "app_private"},
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    buyer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("app_private.users.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(60), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(String(30), nullable=False)
    condition: Mapped[str] = mapped_column(String(10), nullable=False)
    price_min: Mapped[int] = mapped_column(nullable=False)
    price_max: Mapped[int] = mapped_column(nullable=False)
    region: Mapped[str] = mapped_column(String(50), nullable=False)
    status: Mapped[str] = mapped_column(String(10), nullable=False, server_default=text("'open'"))
    thumbnail_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=text("now()"))


class SellerApplication(Base):
    __tablename__ = "seller_applications"
    __table_args__ = (
        ForeignKeyConstraint(
            ["request_id", "buyer_id"],
            ["app_private.purchase_requests.id", "app_private.purchase_requests.buyer_id"],
            ondelete="CASCADE",
            name="fk_seller_applications_request_buyer",
        ),
        UniqueConstraint("request_id", "seller_id", name="uq_seller_applications_request_seller"),
        CheckConstraint("seller_id <> buyer_id", name="ck_seller_applications_not_self"),
        CheckConstraint("offer_price BETWEEN 0 AND 1000000000", name="ck_seller_applications_offer_price"),
        CheckConstraint(
            "char_length(btrim(message)) BETWEEN 2 AND 500", name="ck_seller_applications_message_len"
        ),
        Index("ix_seller_applications_request_created", "request_id", "created_at", "id"),
        Index("ix_seller_applications_seller_id", "seller_id"),
        {"schema": "app_private"},
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    buyer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    seller_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app_private.users.id", ondelete="CASCADE", name="fk_seller_applications_seller"),
        nullable=False,
    )
    offer_price: Mapped[int] = mapped_column(Integer, nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=text("now()"))


class ChatRoom(Base):
    __tablename__ = "chat_rooms"
    __table_args__ = (
        UniqueConstraint("application_id", name="uq_chat_rooms_application"),
        {"schema": "app_private"},
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    application_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("app_private.seller_applications.id", ondelete="CASCADE", name="fk_chat_rooms_application"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=text("now()"))
