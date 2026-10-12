from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, get_optional_user, require_auth_post_request
from app.api.errors import ApiError
from app.core.config import Settings, get_settings
from app.db.models import User
from app.schemas.reviews import (
    CompleteResponse,
    ReviewCreate,
    ReviewEnvelope,
    TransactionReviewsResponse,
)
from app.services.errors import ServiceUnavailable
from app.services.requests import RequestNotFound
from app.services.reviews import (
    AlreadyReviewed,
    RequestNotCompleted,
    ReviewTransactionNotFound,
    create_review,
    get_reviews,
)
from app.services.transactions import CompletionForbidden, RequestNotMatched, complete_transaction

router = APIRouter(prefix="/api/requests", tags=["transaction-reviews"])


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


@router.post(
    "/{request_id}/complete",
    response_model=CompleteResponse,
    dependencies=[Depends(require_auth_post_request)],
)
def complete_transaction_endpoint(
    request_id: UUID,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> CompleteResponse:
    _no_store(response)
    try:
        return complete_transaction(db, request_id=request_id, viewer_id=user.id, settings=settings)
    except RequestNotFound:
        raise ApiError(404, "NOT_FOUND") from None
    except CompletionForbidden:
        raise ApiError(403, "COMPLETION_FORBIDDEN") from None
    except RequestNotMatched:
        raise ApiError(409, "REQUEST_NOT_MATCHED") from None
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None


@router.get("/{request_id}/reviews", response_model=TransactionReviewsResponse)
def get_reviews_endpoint(
    request_id: UUID,
    response: Response,
    viewer: User | None = Depends(get_optional_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> TransactionReviewsResponse:
    _no_store(response)
    try:
        return get_reviews(db, request_id=request_id, viewer_id=viewer.id if viewer else None, settings=settings)
    except RequestNotFound:
        raise ApiError(404, "NOT_FOUND") from None
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None


@router.post(
    "/{request_id}/reviews",
    response_model=ReviewEnvelope,
    dependencies=[Depends(require_auth_post_request)],
)
def create_review_endpoint(
    request_id: UUID,
    payload: ReviewCreate,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ReviewEnvelope:
    _no_store(response)
    try:
        result, created = create_review(
            db, request_id=request_id, reviewer_id=user.id, payload=payload, settings=settings
        )
    except ReviewTransactionNotFound:
        raise ApiError(404, "NOT_FOUND") from None
    except RequestNotCompleted:
        raise ApiError(409, "REQUEST_NOT_COMPLETED") from None
    except AlreadyReviewed:
        raise ApiError(409, "ALREADY_REVIEWED") from None
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None
    response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
    return ReviewEnvelope(review=result)
