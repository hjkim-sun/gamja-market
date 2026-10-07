from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import case, func, or_, select, text
from sqlalchemy.orm import Session, aliased

from app.db.models import ChatMessage, ChatRoom, PurchaseRequest, SellerApplication, User


def create_for_application(db: Session, *, room_id: UUID, application_id: UUID) -> tuple[UUID, datetime]:
    result = db.execute(
        ChatRoom.__table__.insert().values(id=room_id, application_id=application_id).returning(ChatRoom.id, ChatRoom.created_at)
    ).one()
    return result.id, result.created_at


def get_for_participant(
    db: Session, *, room_id: UUID, viewer_id: UUID
) -> tuple[ChatRoom, SellerApplication, PurchaseRequest, str, str] | None:
    buyer = aliased(User)
    seller = aliased(User)
    return db.execute(
        select(ChatRoom, SellerApplication, PurchaseRequest, buyer.email, seller.email)
        .join(SellerApplication, SellerApplication.id == ChatRoom.application_id)
        .join(PurchaseRequest, PurchaseRequest.id == SellerApplication.request_id)
        .join(buyer, buyer.id == SellerApplication.buyer_id)
        .join(seller, seller.id == SellerApplication.seller_id)
        .where(ChatRoom.id == room_id)
        .where(or_(SellerApplication.buyer_id == viewer_id, SellerApplication.seller_id == viewer_id))
    ).one_or_none()


def get_state_for_participant(db: Session, *, room_id: UUID, viewer_id: UUID):
    return db.execute(
        select(ChatRoom.id, SellerApplication.status.label("application_status"), PurchaseRequest.status.label("request_status"),
               SellerApplication.buyer_id, SellerApplication.seller_id)
        .join(SellerApplication, SellerApplication.id == ChatRoom.application_id)
        .join(PurchaseRequest, PurchaseRequest.id == SellerApplication.request_id)
        .where(ChatRoom.id == room_id)
        .where(or_(SellerApplication.buyer_id == viewer_id, SellerApplication.seller_id == viewer_id))
    ).one_or_none()


def lock_for_send(db: Session, *, room_id: UUID, viewer_id: UUID):
    return db.execute(
        text("""
            SELECT r.id AS room_id, a.id AS application_id, a.buyer_id, a.seller_id,
                   a.status AS application_status, p.status AS request_status
              FROM app_private.chat_rooms r
              JOIN app_private.seller_applications a ON a.id = r.application_id
              JOIN app_private.purchase_requests p ON p.id = a.request_id
             WHERE r.id = :room_id AND :viewer_id IN (a.buyer_id, a.seller_id)
             FOR NO KEY UPDATE OF r FOR SHARE OF a
        """),
        {"room_id": room_id, "viewer_id": viewer_id},
    ).mappings().one_or_none()


def list_for_user(db: Session, *, viewer_id: UUID, limit: int):
    latest_message = (
        select(
            ChatMessage.room_id.label("room_id"), ChatMessage.body.label("body"),
            ChatMessage.sender_id.label("sender_id"), ChatMessage.created_at.label("created_at"),
            func.row_number().over(partition_by=ChatMessage.room_id, order_by=ChatMessage.seq.desc()).label("rn"),
        ).subquery()
    )
    other_id = case(
        (SellerApplication.buyer_id == viewer_id, SellerApplication.seller_id), else_=SellerApplication.buyer_id
    )
    counterpart = aliased(User)
    viewer_role = case((SellerApplication.buyer_id == viewer_id, "buyer"), else_="seller")
    return list(
        db.execute(
            select(ChatRoom, SellerApplication, PurchaseRequest, counterpart.id, counterpart.email,
                   viewer_role.label("viewer_role"), latest_message.c.body, latest_message.c.sender_id,
                   latest_message.c.created_at)
            .join(SellerApplication, SellerApplication.id == ChatRoom.application_id)
            .join(PurchaseRequest, PurchaseRequest.id == SellerApplication.request_id)
            .join(counterpart, counterpart.id == other_id)
            .outerjoin(latest_message, (latest_message.c.room_id == ChatRoom.id) & (latest_message.c.rn == 1))
            .where(or_(SellerApplication.buyer_id == viewer_id, SellerApplication.seller_id == viewer_id))
            .order_by(func.coalesce(latest_message.c.created_at, ChatRoom.created_at).desc(), ChatRoom.id.desc())
            .limit(limit + 1)
        ).all()
    )
