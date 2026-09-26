from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session, aliased

from app.db.models import ChatRoom, PurchaseRequest, SellerApplication, User


def lock_request_for_application(db: Session, request_id: UUID) -> tuple[PurchaseRequest, str] | None:
    """Lock just the purchase-request row with PostgreSQL FOR SHARE.

    Share locks are compatible with one another, allowing independent sellers to
    apply concurrently while preventing a status update from passing the open
    check during this transaction.
    """
    return db.execute(
        select(PurchaseRequest, User.email)
        .join(User, User.id == PurchaseRequest.buyer_id)
        .where(PurchaseRequest.id == request_id)
        .with_for_update(read=True, of=PurchaseRequest)
    ).one_or_none()


def insert_application(
    db: Session,
    *,
    application_id: UUID,
    request_id: UUID,
    buyer_id: UUID,
    seller_id: UUID,
    offer_price: int,
    message: str,
) -> tuple[UUID, datetime] | None:
    result = db.execute(
        insert(SellerApplication)
        .values(
            id=application_id,
            request_id=request_id,
            buyer_id=buyer_id,
            seller_id=seller_id,
            offer_price=offer_price,
            message=message,
        )
        .on_conflict_do_nothing(constraint="uq_seller_applications_request_seller")
        .returning(SellerApplication.id, SellerApplication.created_at)
    ).one_or_none()
    return (result.id, result.created_at) if result is not None else None


def count_for_request(db: Session, request_id: UUID) -> int:
    return int(
        db.scalar(select(func.count()).select_from(SellerApplication).where(SellerApplication.request_id == request_id))
        or 0
    )


def request_exists_and_buyer(db: Session, request_id: UUID) -> UUID | None:
    return db.scalar(select(PurchaseRequest.buyer_id).where(PurchaseRequest.id == request_id))


def list_for_request(
    db: Session,
    *,
    request_id: UUID,
    viewer_id: UUID | None,
    role: str,
) -> list[tuple[SellerApplication, UUID, str]]:
    seller = aliased(User)
    statement = (
        select(SellerApplication, ChatRoom.id, seller.email)
        .join(ChatRoom, ChatRoom.application_id == SellerApplication.id)
        .join(seller, seller.id == SellerApplication.seller_id)
        .where(SellerApplication.request_id == request_id)
        .order_by(SellerApplication.created_at.asc(), SellerApplication.id.asc())
    )
    if role == "applicant" and viewer_id is not None:
        statement = statement.where(SellerApplication.seller_id == viewer_id)
    elif role != "owner":
        return []
    return list(db.execute(statement).all())
