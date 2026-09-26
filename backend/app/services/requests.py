from __future__ import annotations

from datetime import timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.security import utcnow
from app.core.db_logging import log_database_failure
from app.db.models import PurchaseRequest, PurchaseRequestPhoto
from app.services.photo_urls import photo_url
from app.repositories import requests as request_repository
from app.schemas.requests import PurchaseRequestCreate, RequestListParams
from app.services.errors import ServiceUnavailable


class RequestNotFound(Exception):
    pass


def mask_email(email: str) -> str:
    local, separator, domain = email.partition("@")
    visible = local[:2] if len(local) >= 2 else local
    return f"{visible}{'*' * max(1, len(local) - len(visible))}{separator}{domain}"


def _photo_data(photo: PurchaseRequestPhoto, namespace: tuple[str, str | None], settings: Settings) -> dict[str, Any] | None:
    url = photo_url(namespace, photo.storage_path, photo.id, photo.storage_path.rsplit(".", 1)[-1], settings.supabase_url)
    return {"id": photo.id, "url": url} if url else None


def _summary_data(request: PurchaseRequest, viewer_id: UUID | None, thumbnail_url: str | None = None) -> dict[str, Any]:
    return {
        "id": request.id,
        "title": request.title,
        "category": request.category,
        "condition": request.condition,
        "price_min": request.price_min,
        "price_max": request.price_max,
        "region": request.region,
        "status": request.status,
        "thumbnail_url": thumbnail_url,
        "applicant_count": 0,
        "created_at": request.created_at,
        "is_owner": viewer_id == request.buyer_id,
    }


def _detail_data(request: PurchaseRequest, buyer_email: str, viewer_id: UUID | None, photos: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        **_summary_data(request, viewer_id, (photos or [{}])[0].get("url") if photos else None),
        "description": request.description,
        "updated_at": request.updated_at,
        "buyer": {"id": request.buyer_id, "masked_email": mask_email(buyer_email)},
        "photos": photos or [],
    }


def create_request(
    db: Session,
    *,
    buyer_id: UUID,
    buyer_email: str,
    payload: PurchaseRequestCreate,
    settings: Settings,
    namespace: tuple[str, str | None],
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
        if payload.photo_ids:
            bucket_condition = PurchaseRequestPhoto.storage_bucket.is_(namespace[1]) if namespace[1] is None else PurchaseRequestPhoto.storage_bucket == namespace[1]
            photos = list(db.execute(select(PurchaseRequestPhoto).where(
                PurchaseRequestPhoto.id.in_(payload.photo_ids), PurchaseRequestPhoto.uploader_id == buyer_id,
                PurchaseRequestPhoto.status == "pending", PurchaseRequestPhoto.request_id.is_(None),
                PurchaseRequestPhoto.storage_backend == namespace[0], bucket_condition,
                PurchaseRequestPhoto.created_at > utcnow() - timedelta(hours=24),
            ).order_by(PurchaseRequestPhoto.id).with_for_update()).scalars())
            if len(photos) != len(payload.photo_ids):
                db.rollback()
                raise InvalidPhotoIds
            by_id = {photo.id: photo for photo in photos}
            attached_by_id: dict[UUID, dict[str, Any]] = {}
            for index, photo_id in enumerate(payload.photo_ids):
                photo = by_id[photo_id]
                photo.status, photo.request_id, photo.sort_order, photo.updated_at = "attached", request.id, index, utcnow()
                data = _photo_data(photo, namespace, settings)
                if data is not None:
                    attached_by_id[photo_id] = data
        db.commit()
        attached = [attached_by_id[photo_id] for photo_id in payload.photo_ids if photo_id in attached_by_id] if payload.photo_ids else []
        return _detail_data(request, buyer_email, buyer_id, attached)
    except InvalidPhotoIds:
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        log_database_failure("create_request", exc, settings)
        raise ServiceUnavailable from None


class InvalidPhotoIds(Exception):
    pass


def _attached_for_request(db: Session, request_id: UUID, namespace: tuple[str, str | None], settings: Settings) -> list[dict[str, Any]]:
    bucket_condition = PurchaseRequestPhoto.storage_bucket.is_(namespace[1]) if namespace[1] is None else PurchaseRequestPhoto.storage_bucket == namespace[1]
    photos = db.execute(select(PurchaseRequestPhoto).where(
        PurchaseRequestPhoto.request_id == request_id, PurchaseRequestPhoto.status == "attached",
        PurchaseRequestPhoto.storage_backend == namespace[0], bucket_condition,
    ).order_by(PurchaseRequestPhoto.sort_order)).scalars()
    return [data for photo in photos if (data := _photo_data(photo, namespace, settings)) is not None]


def list_requests(
    db: Session,
    *,
    params: RequestListParams,
    viewer_id: UUID | None,
    settings: Settings,
    namespace: tuple[str, str | None],
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
        request_ids = [request.id for request, _ in rows]
        thumbnails: dict[UUID, str] = {}
        if request_ids:
            bucket_condition = PurchaseRequestPhoto.storage_bucket.is_(namespace[1]) if namespace[1] is None else PurchaseRequestPhoto.storage_bucket == namespace[1]
            photos = db.execute(select(PurchaseRequestPhoto).where(
                PurchaseRequestPhoto.request_id.in_(request_ids), PurchaseRequestPhoto.status == "attached",
                PurchaseRequestPhoto.sort_order == 0, PurchaseRequestPhoto.storage_backend == namespace[0], bucket_condition,
            )).scalars()
            thumbnails = {photo.request_id: data["url"] for photo in photos if photo.request_id and (data := _photo_data(photo, namespace, settings))}
        return [_summary_data(request, viewer_id, thumbnails.get(request.id)) for request, _ in rows], total
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
    namespace: tuple[str, str | None],
) -> dict[str, Any]:
    try:
        record = request_repository.get_by_id(db, request_id)
        if record is not None:
            request, buyer_email = record
            photos = _attached_for_request(db, request.id, namespace, settings)
    except SQLAlchemyError as exc:
        db.rollback()
        log_database_failure("get_request", exc, settings)
        raise ServiceUnavailable from None
    if record is None:
        raise RequestNotFound
    return _detail_data(request, buyer_email, viewer_id, photos)
