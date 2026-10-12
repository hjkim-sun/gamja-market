from __future__ import annotations

from uuid import UUID

from sqlalchemy import text, update
from sqlalchemy.exc import IntegrityError, OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.db_logging import log_database_failure
from app.db.models import PurchaseRequest
from app.repositories import applications as application_repository
from app.schemas.reviews import CompleteResponse
from app.services.errors import ServiceUnavailable
from app.services.requests import RequestNotFound


class CompletionForbidden(Exception):
    pass


class RequestNotMatched(Exception):
    pass


def complete_transaction(db: Session, *, request_id: UUID, viewer_id: UUID, settings: Settings) -> dict:
    try:
        db.execute(text("SELECT set_config('lock_timeout', :timeout, true)"),
                   {"timeout": f"{settings.application_lock_timeout_ms}ms"})
        request = application_repository.lock_request_for_match(db, request_id)
        if request is None:
            db.rollback()
            raise RequestNotFound
        if request.buyer_id != viewer_id:
            db.rollback()
            raise CompletionForbidden
        if request.status == "completed":
            accepted = application_repository.lock_accepted_application(db, request_id)
            if accepted is None:
                db.rollback()
                log_database_failure("complete_transaction_invariant", RuntimeError("accepted application missing"), settings)
                raise ServiceUnavailable
            result = CompleteResponse.model_validate({
                "request": {"id": request.id, "status": "completed", "completed_at": request.completed_at},
                "accepted_application_id": accepted.id,
                "chat_room_id": accepted.room_id,
            })
            db.rollback()
            return result
        if request.status != "matched":
            db.rollback()
            raise RequestNotMatched
        accepted = application_repository.lock_accepted_application(db, request_id)
        if accepted is None:
            db.rollback()
            raise RequestNotMatched
        completed_at = db.scalar(text("SELECT clock_timestamp()"))
        changed = db.execute(
            update(PurchaseRequest)
            .where(PurchaseRequest.id == request_id, PurchaseRequest.status == "matched")
            .values(status="completed", completed_at=completed_at, updated_at=completed_at)
            .returning(PurchaseRequest.completed_at)
        ).one_or_none()
        if changed is None:
            db.rollback()
            log_database_failure("complete_transaction_invariant", RuntimeError("request update count"), settings)
            raise ServiceUnavailable
        result = CompleteResponse.model_validate({
            "request": {"id": request.id, "status": "completed", "completed_at": changed.completed_at},
            "accepted_application_id": accepted.id,
            "chat_room_id": accepted.room_id,
        })
        db.commit()
        return result
    except (RequestNotFound, CompletionForbidden, RequestNotMatched, ServiceUnavailable):
        raise
    except (IntegrityError, OperationalError, SQLAlchemyError) as exc:
        db.rollback()
        log_database_failure("complete_transaction", exc, settings)
        raise ServiceUnavailable from None
    except Exception:
        db.rollback()
        raise
