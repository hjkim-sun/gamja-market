from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.db.models import PurchaseRequest, Review, SellerApplication


def get_transaction(db: Session, request_id: UUID):
    return db.execute(
        select(
            PurchaseRequest.id,
            PurchaseRequest.buyer_id,
            PurchaseRequest.status,
            PurchaseRequest.completed_at,
            SellerApplication.seller_id,
        )
        .outerjoin(
            SellerApplication,
            (SellerApplication.request_id == PurchaseRequest.id) & (SellerApplication.status == "accepted"),
        )
        .where(PurchaseRequest.id == request_id)
    ).one_or_none()


def insert_review(
    db: Session,
    *,
    review_id: UUID,
    request_id: UUID,
    reviewer_id: UUID,
    reviewee_id: UUID,
    reviewer_role: str,
    rating: int,
    body: str,
):
    return db.execute(
        insert(Review)
        .values(
            id=review_id,
            request_id=request_id,
            reviewer_id=reviewer_id,
            reviewee_id=reviewee_id,
            reviewer_role=reviewer_role,
            rating=rating,
            body=body,
        )
        .on_conflict_do_nothing()
        .returning(Review.id, Review.reviewer_role, Review.rating, Review.body, Review.created_at)
    ).one_or_none()


def get_by_reviewer(db: Session, *, request_id: UUID, reviewer_id: UUID):
    return db.execute(
        select(Review.id, Review.reviewer_role, Review.rating, Review.body, Review.created_at)
        .where(Review.request_id == request_id, Review.reviewer_id == reviewer_id)
    ).one_or_none()


def list_for_request(db: Session, request_id: UUID):
    return list(
        db.execute(
            select(Review.id, Review.reviewer_id, Review.reviewee_id, Review.reviewer_role,
                   Review.rating, Review.body, Review.created_at)
            .where(Review.request_id == request_id)
            .order_by(Review.reviewer_role.asc())
            .limit(2)
        ).all()
    )
