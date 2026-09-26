from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.db_logging import log_database_failure
from app.db.models import PurchaseRequest
from app.repositories import requests as request_repository
from app.schemas.requests import PurchaseRequestCreate, RequestListParams
from app.services.errors import ServiceUnavailable


class RequestNotFound(Exception):
    pass


def mask_email(email: str) -> str:
    local, separator, domain = email.partition("@")
    visible = local[:2] if len(local) >= 2 else local
    return f"{visible}{'*' * max(1, len(local) - len(visible))}{separator}{domain}"


def _summary_data(request: PurchaseRequest, viewer_id: UUID | None, applicant_count: int = 0) -> dict[str, Any]:
    return {
        "id": request.id,
        "title": request.title,
        "category": request.category,
        "condition": request.condition,
        "price_min": request.price_min,
        "price_max": request.price_max,
        "region": request.region,
        "status": request.status,
        "thumbnail_url": request.thumbnail_url,
        "applicant_count": applicant_count,
        "created_at": request.created_at,
        "is_owner": viewer_id == request.buyer_id,
    }


def _detail_data(
    request: PurchaseRequest, buyer_email: str, viewer_id: UUID | None, applicant_count: int = 0
) -> dict[str, Any]:
    return {
        **_summary_data(request, viewer_id, applicant_count),
        "description": request.description,
        "updated_at": request.updated_at,
        "buyer": {"id": request.buyer_id, "masked_email": mask_email(buyer_email)},
    }


def create_request(
    db: Session,
    *,
    buyer_id: UUID,
    buyer_email: str,
    payload: PurchaseRequestCreate,
    settings: Settings,
) -> dict[str, Any]:
    try:
        request = request_repository.create(
            db,
            buyer_id=buyer_id,
            title=payload.title,
            category=payload.category,
            description=payload.description,
            price_min=payload.price_min,
            price_max=payload.price_max,
            condition=payload.condition,
            region=payload.region,
        )
        db.commit()
        return _detail_data(request, buyer_email, buyer_id)
    except SQLAlchemyError as exc:
        db.rollback()
        log_database_failure("create_request", exc, settings)
        raise ServiceUnavailable from None


def list_requests(
    db: Session,
    *,
    params: RequestListParams,
    viewer_id: UUID | None,
    settings: Settings,
) -> tuple[list[dict[str, Any]], int]:
    try:
        rows, total = request_repository.list_and_count(
            db,
            q=params.q,
            category=params.category,
            status=params.status,
            sort=params.sort,
            page=params.page,
            page_size=params.page_size,
        )
        return [_summary_data(request, viewer_id, applicant_count) for request, _, applicant_count in rows], total
    except SQLAlchemyError as exc:
        db.rollback()
        log_database_failure("list_requests", exc, settings)
        raise ServiceUnavailable from None


def get_request(
    db: Session,
    *,
    request_id: UUID,
    viewer_id: UUID | None,
    settings: Settings,
) -> dict[str, Any]:
    try:
        record = request_repository.get_by_id(db, request_id)
    except SQLAlchemyError as exc:
        db.rollback()
        log_database_failure("get_request", exc, settings)
        raise ServiceUnavailable from None
    if record is None:
        raise RequestNotFound
    request, buyer_email, applicant_count = record
    return _detail_data(request, buyer_email, viewer_id, applicant_count)
