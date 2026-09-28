from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, aliased

from app.db.models import ChatRoom, PurchaseRequest, SellerApplication, User


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
