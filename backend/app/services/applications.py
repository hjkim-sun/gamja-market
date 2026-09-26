from __future__ import annotations

import uuid
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.db_logging import log_database_failure
from app.db.models import PurchaseRequest, User
from app.repositories import applications as application_repository
from app.repositories import chat_rooms as chat_room_repository
from app.schemas.applications import ApplicationCreate, ApplyResponse
from app.services.errors import ServiceUnavailable
from app.services.requests import RequestNotFound, mask_email


class SelfApplicationForbidden(Exception):
    pass


class RequestNotOpen(Exception):
    pass


class AlreadyApplied(Exception):
    pass


class ChatRoomNotFound(Exception):
    pass


def _masked_user(user_id: UUID, email: str) -> dict[str, Any]:
    return {"id": user_id, "masked_email": mask_email(email)}


def _application_data(application, room_id: UUID, seller_email: str) -> dict[str, Any]:
    return {
        "id": application.id,
        "request_id": application.request_id,
        "seller": _masked_user(application.seller_id, seller_email),
        "offer_price": application.offer_price,
        "message": application.message,
        "chat_room_id": room_id,
        "created_at": application.created_at,
    }


def _room_data(
    *,
    room_id: UUID,
    application_id: UUID,
    room_created_at,
    request: PurchaseRequest,
    buyer_email: str,
    seller_id: UUID,
    seller_email: str,
    offer_price: int,
    message: str,
    viewer_role: str,
) -> ApplyResponse:
    return {
        "id": room_id,
        "application_id": application_id,
        "viewer_role": viewer_role,
        "request": {
            "id": request.id,
            "title": request.title,
            "status": request.status,
            "price_min": request.price_min,
            "price_max": request.price_max,
        },
        "buyer": _masked_user(request.buyer_id, buyer_email),
        "seller": _masked_user(seller_id, seller_email),
        "offer_price": offer_price,
        "application_message": message,
        "created_at": room_created_at,
    }


def _constraint_name(exc: IntegrityError) -> str | None:
    return getattr(getattr(exc, "orig", None), "diag", None) and getattr(exc.orig.diag, "constraint_name", None)


def apply_to_request(
    db: Session,
    *,
    request_id: UUID,
    seller: User,
    payload: ApplicationCreate,
    settings: Settings,
) -> dict[str, Any]:
    """Create one application and its private room in a single commit."""
    try:
        db.execute(
            text("SELECT set_config('lock_timeout', :timeout, true)"),
            {"timeout": f"{settings.application_lock_timeout_ms}ms"},
        )
        locked = application_repository.lock_request_for_application(db, request_id)
        if locked is None:
            db.rollback()
            raise RequestNotFound
        request, buyer_email = locked
        if request.buyer_id == seller.id:
            db.rollback()
            raise SelfApplicationForbidden
        if request.status != "open":
            db.rollback()
            raise RequestNotOpen

        application_id = uuid.uuid4()
        inserted = application_repository.insert_application(
            db,
            application_id=application_id,
            request_id=request.id,
            buyer_id=request.buyer_id,
            seller_id=seller.id,
            offer_price=payload.offer_price,
            message=payload.message,
        )
        if inserted is None:
            db.rollback()
            raise AlreadyApplied
        application_id, application_created_at = inserted
        room_id, room_created_at = chat_room_repository.create_for_application(
            db, room_id=uuid.uuid4(), application_id=application_id
        )

        # Validate the completed DTO before the sole commit.  If response
        # construction ever becomes invalid, neither INSERT is durable.
        application_data = {
            "id": application_id,
            "request_id": request.id,
            "seller": _masked_user(seller.id, seller.email),
            "offer_price": payload.offer_price,
            "message": payload.message,
            "chat_room_id": room_id,
            "created_at": application_created_at,
        }
        room_data = _room_data(
            room_id=room_id,
            application_id=application_id,
            room_created_at=room_created_at,
            request=request,
            buyer_email=buyer_email,
            seller_id=seller.id,
            seller_email=seller.email,
            offer_price=payload.offer_price,
            message=payload.message,
            viewer_role="seller",
        )
        response = ApplyResponse.model_validate({"application": application_data, "chat_room": room_data})
        db.commit()
        return response
    except IntegrityError as exc:
        db.rollback()
        constraint = _constraint_name(exc)
        if constraint == "uq_seller_applications_request_seller":
            raise AlreadyApplied from None
        if constraint == "ck_seller_applications_not_self":
            raise SelfApplicationForbidden from None
        log_database_failure("apply_to_request", exc, settings)
        raise ServiceUnavailable from None
    except (OperationalError, SQLAlchemyError) as exc:
        db.rollback()
        log_database_failure("apply_to_request", exc, settings)
        raise ServiceUnavailable from None
    except Exception:
        # Non-database failures raised before a successful commit (including
        # DTO validation) must not leave the application or room pending.
        db.rollback()
        raise


def list_applications(
    db: Session, *, request_id: UUID, viewer_id: UUID | None, settings: Settings
) -> dict[str, Any]:
    try:
        buyer_id = application_repository.request_exists_and_buyer(db, request_id)
        if buyer_id is None:
            raise RequestNotFound
        count = application_repository.count_for_request(db, request_id)
        if viewer_id is None:
            role = "anonymous"
        elif viewer_id == buyer_id:
            role = "owner"
        else:
            role = "applicant" if db.scalar(
                text(
                    "SELECT EXISTS (SELECT 1 FROM app_private.seller_applications "
                    "WHERE request_id = :request_id AND seller_id = :seller_id)"
                ),
                {"request_id": request_id, "seller_id": viewer_id},
            ) else "member"
        rows = application_repository.list_for_request(db, request_id=request_id, viewer_id=viewer_id, role=role)
        return {
            "viewer_role": role,
            "applicant_count": count,
            "items": [_application_data(application, room_id, seller_email) for application, room_id, seller_email in rows],
        }
    except RequestNotFound:
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        log_database_failure("list_applications", exc, settings)
        raise ServiceUnavailable from None


def get_chat_room(
    db: Session, *, room_id: UUID, viewer: User, settings: Settings
) -> dict[str, Any]:
    try:
        record = chat_room_repository.get_for_participant(db, room_id=room_id, viewer_id=viewer.id)
        if record is None:
            raise ChatRoomNotFound
        room, application, request, buyer_email, seller_email = record
        return _room_data(
            room_id=room.id,
            application_id=application.id,
            room_created_at=room.created_at,
            request=request,
            buyer_email=buyer_email,
            seller_id=application.seller_id,
            seller_email=seller_email,
            offer_price=application.offer_price,
            message=application.message,
            viewer_role="buyer" if viewer.id == application.buyer_id else "seller",
        )
    except ChatRoomNotFound:
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        log_database_failure("get_chat_room", exc, settings)
        raise ServiceUnavailable from None
