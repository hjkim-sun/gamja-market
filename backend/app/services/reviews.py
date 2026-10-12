from __future__ import annotations

from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.db_logging import log_database_failure
from app.repositories import reviews as review_repository
from app.schemas.reviews import ReviewCreate, ReviewView, TransactionReviewsResponse
from app.services.errors import ServiceUnavailable
from app.services.requests import RequestNotFound


class ReviewTransactionNotFound(Exception):
    pass


class RequestNotCompleted(Exception):
    pass


class AlreadyReviewed(Exception):
    pass


def _public_view(row) -> dict:
    return {
        "reviewer_role": row.reviewer_role,
        "rating": row.rating,
        "body": row.body,
        "created_at": row.created_at,
    }


def get_reviews(
    db: Session, *, request_id: UUID, viewer_id: UUID | None, settings: Settings
) -> dict:
    try:
        transaction = review_repository.get_transaction(db, request_id)
        if transaction is None:
            raise RequestNotFound
        rows = review_repository.list_for_request(db, request_id) if transaction.status == "completed" else []
        role = None
        if viewer_id is not None:
            if viewer_id == transaction.buyer_id:
                role = "buyer"
            elif transaction.seller_id is not None and viewer_id == transaction.seller_id:
                role = "seller"
        mine_row = next((row for row in rows if row.reviewer_id == viewer_id), None) if role else None
        received_row = next((row for row in rows if row.reviewee_id == viewer_id), None) if role else None
        mine = _public_view(mine_row) if mine_row else None
        received = _public_view(received_row) if received_row else None
        return TransactionReviewsResponse.model_validate({
            "request_id": transaction.id,
            "request_status": transaction.status,
            "completed_at": transaction.completed_at,
            "items": [_public_view(row) for row in rows],
            "viewer_role": role,
            "can_write": bool(role and transaction.status == "completed" and mine is None),
            "mine": mine,
            "received": received,
        })
    except RequestNotFound:
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        log_database_failure("get_reviews", exc, settings)
        raise ServiceUnavailable from None


def create_review(
    db: Session,
    *,
    request_id: UUID,
    reviewer_id: UUID,
    payload: ReviewCreate,
    settings: Settings,
) -> tuple[ReviewView, bool]:
    try:
        db.execute(
            text("SELECT set_config('lock_timeout', :timeout, true)"),
            {"timeout": f"{settings.application_lock_timeout_ms}ms"},
        )
        transaction = review_repository.get_transaction(db, request_id)
        if transaction is None or reviewer_id not in {transaction.buyer_id, transaction.seller_id}:
            db.rollback()
            raise ReviewTransactionNotFound
        if transaction.status != "completed":
            db.rollback()
            raise RequestNotCompleted
        reviewer_role = "buyer" if reviewer_id == transaction.buyer_id else "seller"
        reviewee_id = transaction.seller_id if reviewer_role == "buyer" else transaction.buyer_id
        if reviewee_id is None:
            db.rollback()
            raise ReviewTransactionNotFound
        row = review_repository.insert_review(
            db,
            review_id=uuid4(),
            request_id=request_id,
            reviewer_id=reviewer_id,
            reviewee_id=reviewee_id,
            reviewer_role=reviewer_role,
            rating=payload.rating,
            body=payload.body,
        )
        if row is not None:
            result = ReviewView.model_validate({"id": row.id, **_public_view(row)})
            db.commit()
            return result, True
        existing = review_repository.get_by_reviewer(db, request_id=request_id, reviewer_id=reviewer_id)
        if existing is None:
            db.rollback()
            log_database_failure("create_review_invariant", RuntimeError("conflict without review"), settings)
            raise ServiceUnavailable
        result = ReviewView.model_validate({"id": existing.id, **_public_view(existing)})
        db.rollback()
        if existing.rating == payload.rating and existing.body == payload.body:
            return result, False
        raise AlreadyReviewed
    except (ReviewTransactionNotFound, RequestNotCompleted, AlreadyReviewed, ServiceUnavailable):
        raise
    except IntegrityError as exc:
        db.rollback()
        log_database_failure("create_review", exc, settings)
        raise ServiceUnavailable from None
    except (OperationalError, SQLAlchemyError) as exc:
        db.rollback()
        log_database_failure("create_review", exc, settings)
        raise ServiceUnavailable from None
    except Exception:
        db.rollback()
        raise
