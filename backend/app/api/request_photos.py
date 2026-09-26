from __future__ import annotations

from datetime import timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response as RawResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, get_photo_storage, require_same_origin_mutation
from app.api.errors import ApiError
from app.db.models import PurchaseRequestPhoto, User
from app.services.errors import ServiceUnavailable
from app.services.photo_validation import ImageTooLarge, InvalidImage, MAX_BYTES, normalize_image
from app.services.request_photos import PhotoLimitExceeded, PhotoNotFound, PhotoUnavailable, active_upload_count, discard_pending, upload_normalized
from app.storage.local import LocalPhotoStorage

router = APIRouter(prefix="/api/request-photos", tags=["request-photos"])
_TYPES = {"image/jpeg", "image/png", "image/webp"}


async def _read_limited(request: Request) -> bytes:
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_BYTES:
            raise ApiError(413, "PAYLOAD_TOO_LARGE")
        body.extend(chunk)
    return bytes(body)


@router.post("", status_code=status.HTTP_201_CREATED, dependencies=[Depends(require_same_origin_mutation)])
async def upload_photo(request: Request, response: Response, user: User = Depends(get_current_user), db: Session = Depends(get_db), storage=Depends(get_photo_storage)):
    response.headers["Cache-Control"] = "no-store"
    if storage is None:
        raise ApiError(503, "PHOTO_STORAGE_UNAVAILABLE")
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type not in _TYPES:
        raise ApiError(415, "UNSUPPORTED_MEDIA_TYPE")
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_BYTES:
        raise ApiError(413, "PAYLOAD_TOO_LARGE")
    try:
        if await run_in_threadpool(active_upload_count, db, user.id) >= 10:
            raise ApiError(409, "PHOTO_LIMIT_EXCEEDED")
    except ApiError:
        raise
    except Exception:
        db.rollback()
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None
    data = await _read_limited(request)
    try:
        image = await run_in_threadpool(normalize_image, data, content_type)
    except ImageTooLarge:
        raise ApiError(413, "PAYLOAD_TOO_LARGE") from None
    except InvalidImage:
        raise ApiError(422, "INVALID_IMAGE") from None
    try:
        photo = await run_in_threadpool(upload_normalized, db, uploader_id=user.id, image=image, storage=storage)
    except PhotoLimitExceeded:
        raise ApiError(409, "PHOTO_LIMIT_EXCEEDED") from None
    except PhotoUnavailable:
        raise ApiError(503, "PHOTO_STORAGE_UNAVAILABLE") from None
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None
    return {"id": photo.id, "contentType": photo.content_type, "byteSize": photo.byte_size, "width": photo.width, "height": photo.height, "expiresAt": photo.created_at + timedelta(hours=24)}


@router.delete("/{photo_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_same_origin_mutation)])
def delete_photo(photo_id: UUID, response: Response, user: User = Depends(get_current_user), db: Session = Depends(get_db), storage=Depends(get_photo_storage)):
    response.headers["Cache-Control"] = "no-store"
    if storage is None:
        raise ApiError(404, "NOT_FOUND")
    try:
        discard_pending(db, photo_id=photo_id, uploader_id=user.id, namespace=storage.namespace, storage=storage)
    except PhotoNotFound:
        raise ApiError(404, "NOT_FOUND") from None
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None
    return RawResponse(status_code=204, headers={"Cache-Control": "no-store"})


@router.get("/files/{photo_id}.{ext}")
def local_photo_file(photo_id: UUID, ext: str, db: Session = Depends(get_db), storage=Depends(get_photo_storage)):
    if not isinstance(storage, LocalPhotoStorage) or ext not in {"jpg", "png", "webp"}:
        raise ApiError(404, "NOT_FOUND")
    try:
        photo = db.execute(select(PurchaseRequestPhoto).where(
            PurchaseRequestPhoto.id == photo_id, PurchaseRequestPhoto.status == "attached",
            PurchaseRequestPhoto.storage_backend == "local", PurchaseRequestPhoto.storage_bucket.is_(None),
        )).scalar_one_or_none()
    except Exception:
        db.rollback()
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None
    if photo is None or not photo.storage_path.endswith(f".{ext}"):
        raise ApiError(404, "NOT_FOUND")
    try:
        data = storage.read(photo.storage_path)
    except OSError:
        raise ApiError(404, "NOT_FOUND") from None
    return RawResponse(content=data, media_type=photo.content_type, headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=3600"})
