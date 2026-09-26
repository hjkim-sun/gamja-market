from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from collections.abc import Callable
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.db.models import PurchaseRequestPhoto, User
from app.db.session import SessionLocal
from app.services.errors import ServiceUnavailable

logger = logging.getLogger(__name__)
TTL = timedelta(hours=24)


class PhotoLimitExceeded(Exception):
    pass


class PhotoUnavailable(Exception):
    pass


class PhotoNotFound(Exception):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


def active_upload_count(db: Session, uploader_id: uuid.UUID) -> int:
    return int(db.scalar(select(func.count()).select_from(PurchaseRequestPhoto).where(
        PurchaseRequestPhoto.uploader_id == uploader_id,
        PurchaseRequestPhoto.status.in_(("uploading", "pending")),
        PurchaseRequestPhoto.created_at > _now() - TTL,
    )) or 0)


def reserve_upload(
    db: Session, *, uploader_id: uuid.UUID, namespace: tuple[str, str | None], image: Any
) -> PurchaseRequestPhoto:
    try:
        db.execute(select(User.id).where(User.id == uploader_id).with_for_update(key_share=True))
        if active_upload_count(db, uploader_id) >= 10:
            db.rollback()
            raise PhotoLimitExceeded
        photo_id = uuid.uuid4()
        photo = PurchaseRequestPhoto(
            id=photo_id, uploader_id=uploader_id, status="uploading", storage_backend=namespace[0],
            storage_bucket=namespace[1], storage_path=f"photos/{photo_id}.{image.ext}",
            content_type=image.content_type, byte_size=len(image.data), width=image.width, height=image.height,
        )
        db.add(photo)
        db.commit()
        db.refresh(photo)
        return photo
    except PhotoLimitExceeded:
        raise
    except SQLAlchemyError:
        db.rollback()
        raise ServiceUnavailable from None


def _discard(db: Session, photo_id: uuid.UUID, *, storage: Any, path: str, record_deleted: bool) -> bool:
    """Commit discarded first. A failure means no storage call (I-3)."""
    try:
        changed = db.execute(update(PurchaseRequestPhoto).where(
            PurchaseRequestPhoto.id == photo_id, PurchaseRequestPhoto.status == "uploading"
        ).values(status="discarded", discarded_at=_now(), updated_at=_now())).rowcount
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        return False
    if not changed:
        return False
    try:
        if path in storage.delete_many([path]) and record_deleted:
            db.execute(update(PurchaseRequestPhoto).where(PurchaseRequestPhoto.id == photo_id, PurchaseRequestPhoto.status == "discarded").values(object_deleted_at=_now(), updated_at=_now()))
            db.commit()
    except Exception:
        db.rollback()
    return True


def upload_normalized(
    db: Session, *, uploader_id: uuid.UUID, image: Any, storage: Any,
    fresh_session_factory: Callable[[], Session] = SessionLocal,
) -> PurchaseRequestPhoto:
    photo = reserve_upload(db, uploader_id=uploader_id, namespace=storage.namespace, image=image)
    photo_id, storage_path = photo.id, photo.storage_path
    try:
        storage.put(storage_path, image.data, image.content_type)
    except Exception:
        _discard(db, photo_id, record_deleted=False, storage=storage, path=storage_path)
        raise PhotoUnavailable from None
    try:
        changed = db.execute(update(PurchaseRequestPhoto).where(
            PurchaseRequestPhoto.id == photo_id, PurchaseRequestPhoto.status == "uploading"
        ).values(status="pending", updated_at=_now())).rowcount
        if changed != 1:
            raise SQLAlchemyError("unexpected state")
        db.commit()
        db.refresh(photo)
        return photo
    except SQLAlchemyError:
        db.rollback()
        # A fresh read is the only authority after an ambiguous commit.
        try:
            reread_db = fresh_session_factory()
        except Exception:
            raise ServiceUnavailable from None
        try:
            reread = reread_db.get(PurchaseRequestPhoto, photo_id)
        except Exception:
            reread_db.rollback()
            reread_db.close()
            raise ServiceUnavailable from None
        if reread is not None and reread.status == "pending":
            reread_db.close()
            return reread
        if reread is not None and reread.status == "uploading":
            _discard(reread_db, photo_id, record_deleted=True, storage=storage, path=storage_path)
        reread_db.close()
        raise ServiceUnavailable from None


def discard_pending(db: Session, *, photo_id: uuid.UUID, uploader_id: uuid.UUID, namespace: tuple[str, str | None], storage: Any) -> None:
    try:
        photo = db.execute(select(PurchaseRequestPhoto).where(
            PurchaseRequestPhoto.id == photo_id, PurchaseRequestPhoto.uploader_id == uploader_id,
            PurchaseRequestPhoto.status == "pending", PurchaseRequestPhoto.storage_backend == namespace[0],
            PurchaseRequestPhoto.storage_bucket.is_(namespace[1]) if namespace[1] is None else PurchaseRequestPhoto.storage_bucket == namespace[1],
        ).with_for_update()).scalar_one_or_none()
        if photo is None:
            db.rollback()
            raise PhotoNotFound
        photo.status, photo.discarded_at, photo.updated_at = "discarded", _now(), _now()
        db.commit()
    except PhotoNotFound:
        raise
    except SQLAlchemyError:
        db.rollback()
        raise ServiceUnavailable from None
    try:
        if photo.storage_path in storage.delete_many([photo.storage_path]):
            db.execute(update(PurchaseRequestPhoto).where(PurchaseRequestPhoto.id == photo.id, PurchaseRequestPhoto.status == "discarded").values(object_deleted_at=_now(), updated_at=_now()))
            db.commit()
    except Exception:
        db.rollback()


def sweep_request_photos(db: Session, storage: Any, namespace: tuple[str, str | None], *, now: datetime, limit: int, dry_run: bool, uploader_id: uuid.UUID | None = None) -> dict[str, int]:
    if namespace[0] == "disabled":
        raise PhotoUnavailable
    query = select(PurchaseRequestPhoto).where(PurchaseRequestPhoto.storage_backend == namespace[0], PurchaseRequestPhoto.object_deleted_at.is_(None))
    query = query.where(PurchaseRequestPhoto.storage_bucket.is_(namespace[1]) if namespace[1] is None else PurchaseRequestPhoto.storage_bucket == namespace[1])
    if uploader_id is not None:
        query = query.where(PurchaseRequestPhoto.uploader_id == uploader_id)
    query = query.where(((PurchaseRequestPhoto.status.in_(("uploading", "pending"))) & (PurchaseRequestPhoto.created_at < now - timedelta(hours=25))) | ((PurchaseRequestPhoto.status == "discarded") & (PurchaseRequestPhoto.discarded_at < now - timedelta(hours=1))))
    rows = list(db.execute(query.order_by(PurchaseRequestPhoto.id).with_for_update(skip_locked=True).limit(limit)).scalars())
    if dry_run:
        db.rollback()
        return {"candidates": len(rows), "deleted": 0, "skipped": 0}
    paths: list[tuple[uuid.UUID, str]] = []
    for row in rows:
        if row.status in {"uploading", "pending"}:
            row.status, row.discarded_at, row.updated_at = "discarded", now, now
        paths.append((row.id, row.storage_path))
    try:
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        return {"candidates": len(rows), "deleted": 0, "skipped": 0}
    try:
        confirmed = storage.delete_many([path for _, path in paths])
    except Exception:
        confirmed = set()
    if confirmed:
        db.execute(update(PurchaseRequestPhoto).where(PurchaseRequestPhoto.id.in_([id_ for id_, path in paths if path in confirmed]), PurchaseRequestPhoto.status == "discarded").values(object_deleted_at=now, updated_at=now))
        db.commit()
    return {"candidates": len(rows), "deleted": len(confirmed), "skipped": 0}
