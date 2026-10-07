from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError, OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.db_logging import log_database_failure
from app.db.models import ChatRoom, PurchaseRequest
from app.repositories import applications as application_repository
from app.repositories import chat_rooms as chat_room_repository
from app.schemas.applications import MatchResponse
from app.services.errors import ServiceUnavailable
from app.services.requests import RequestNotFound


class NotRequestOwner(Exception):
    pass


class RequestAlreadyMatched(Exception):
    pass


class RequestClosed(Exception):
    pass


class ApplicationNotFound(Exception):
    pass


def _constraint_name(exc: IntegrityError) -> str | None:
    return getattr(getattr(exc, "orig", None), "diag", None) and getattr(exc.orig.diag, "constraint_name", None)


def confirm_match(
    db: Session, *, request_id: UUID, application_id: UUID, viewer_id: UUID, settings: Settings
) -> dict:
    operation = "confirm_match"
    try:
        db.execute(
            text("SELECT set_config('lock_timeout', :timeout, true)"),
            {"timeout": f"{settings.application_lock_timeout_ms}ms"},
        )
        request = application_repository.lock_request_for_match(db, request_id)
        if request is None:
            db.rollback()
            raise RequestNotFound
        if request.buyer_id != viewer_id:
            db.rollback()
            raise NotRequestOwner
        application = application_repository.lock_application_in_request(
            db, request_id=request_id, application_id=application_id
        )
        if application is None:
            db.rollback()
            raise ApplicationNotFound

        if request.status == "matched" and application.status == "accepted":
            room_id = db.scalar(
                select(ChatRoom.id).where(ChatRoom.application_id == application.id)
            )
            result = MatchResponse.model_validate({
                "request": {"id": request.id, "status": "matched"},
                "accepted_application_id": application.id,
                "chat_room_id": room_id,
                "closed_application_count": application_repository.count_closed(db, request.id),
            })
            db.rollback()
            return result
        if request.status == "matched":
            db.rollback()
            raise RequestAlreadyMatched
        if request.status == "closed":
            db.rollback()
            raise RequestClosed
        if request.status != "open" or application.status != "pending":
            db.rollback()
            log_database_failure("confirm_match_invariant", RuntimeError("invariant violation"), settings)
            raise ServiceUnavailable

        if application_repository.accept_application(db, application_id=application.id) != 1:
            db.rollback()
            log_database_failure("confirm_match_invariant", RuntimeError("accept update count"), settings)
            raise ServiceUnavailable
        closed_ids = application_repository.close_other_pending(
            db, request_id=request.id, application_id=application.id
        )
        changed = db.execute(
            update(PurchaseRequest)
            .where(PurchaseRequest.id == request.id, PurchaseRequest.status == "open")
            .values(status="matched", updated_at=func.now())
        )
        if changed.rowcount != 1:
            db.rollback()
            log_database_failure("confirm_match_invariant", RuntimeError("request update count"), settings)
            raise ServiceUnavailable
        room_id = db.scalar(
            select(ChatRoom.id).where(ChatRoom.application_id == application.id)
        )
        result = MatchResponse.model_validate({
            "request": {"id": request.id, "status": "matched"},
            "accepted_application_id": application.id,
            "chat_room_id": room_id,
            "closed_application_count": len(closed_ids),
        })
        db.commit()
        return result
    except (RequestNotFound, NotRequestOwner, RequestAlreadyMatched, RequestClosed, ApplicationNotFound, ServiceUnavailable):
        raise
    except IntegrityError as exc:
        db.rollback()
        if _constraint_name(exc) == "uq_seller_applications_one_accepted":
            raise RequestAlreadyMatched from None
        log_database_failure(operation, exc, settings)
        raise ServiceUnavailable from None
    except (OperationalError, SQLAlchemyError) as exc:
        db.rollback()
        log_database_failure(operation, exc, settings)
        raise ServiceUnavailable from None
    except Exception:
        db.rollback()
        raise
