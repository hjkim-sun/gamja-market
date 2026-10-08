from __future__ import annotations

from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.db_logging import log_database_failure
from app.db.models import ChatMessage, User
from app.repositories import chat_messages as message_repository
from app.repositories import chat_rooms as room_repository
from app.schemas.chat import MessageCreate, MessageListParams, MessageView
from app.services.applications import ChatRoomNotFound
from app.services.errors import ServiceUnavailable
from app.services.requests import mask_email


class ChatRoomClosed(Exception):
    pass


def derive_chat_status(application_status: str, request_status: str) -> Literal["active", "matched", "closed"]:
    if application_status == "pending" and request_status == "open":
        return "active"
    if application_status == "accepted" and request_status == "matched":
        return "matched"
    return "closed"


def _message_view(message: ChatMessage, *, viewer_id: UUID, buyer_id: UUID, seller_id: UUID) -> dict:
    return {
        "id": message.id,
        "seq": message.seq,
        "sender_role": "buyer" if message.sender_id == buyer_id else "seller",
        "is_mine": message.sender_id == viewer_id,
        "body": message.body,
        "client_message_id": message.client_message_id,
        "created_at": message.created_at,
    }


def _dto_view(message: ChatMessage, *, viewer_id: UUID, buyer_id: UUID, seller_id: UUID) -> MessageView:
    return MessageView.model_validate(_message_view(message, viewer_id=viewer_id, buyer_id=buyer_id, seller_id=seller_id))


def list_messages(db: Session, *, room_id: UUID, viewer: User, params: MessageListParams, settings: Settings) -> dict:
    try:
        room = room_repository.get_state_for_participant(db, room_id=room_id, viewer_id=viewer.id)
        if room is None:
            raise ChatRoomNotFound
        status = derive_chat_status(room.application_status, room.request_status)
        if params.after_seq is None:
            rows = message_repository.list_latest(db, room_id=room_id, limit=params.limit)
            has_older = len(rows) > params.limit
            items = rows[-params.limit:]
            has_more = False
        else:
            rows = message_repository.list_after(
                db, room_id=room_id, after_seq=params.after_seq, limit=params.limit
            )
            has_more = len(rows) > params.limit
            items = rows[:params.limit]
            has_older = False
        latest_seq = items[-1].seq if items else 0
        return {
            "room": {
                "id": room.id,
                "chat_status": status,
                "can_send": status in {"active", "matched"},
                "application_status": room.application_status,
                "request_status": room.request_status,
            },
            "items": [
                _message_view(item, viewer_id=viewer.id, buyer_id=room.buyer_id, seller_id=room.seller_id)
                for item in items
            ],
            "latest_seq": latest_seq,
            "has_more": has_more,
            "has_older": has_older,
        }
    except ChatRoomNotFound:
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        log_database_failure("list_messages", exc, settings)
        raise ServiceUnavailable from None


def send_message(
    db: Session, *, room_id: UUID, viewer: User, payload: MessageCreate, settings: Settings
) -> tuple[MessageView, bool]:
    try:
        db.execute(
            text("SELECT set_config('lock_timeout', :timeout, true)"),
            {"timeout": f"{settings.application_lock_timeout_ms}ms"},
        )
        room = room_repository.lock_for_send(db, room_id=room_id, viewer_id=viewer.id)
        if room is None:
            db.rollback()
            raise ChatRoomNotFound
        existing = message_repository.find_by_client_id(
            db, room_id=room_id, sender_id=viewer.id, client_message_id=payload.client_message_id
        )
        if existing is not None:
            result = _dto_view(existing, viewer_id=viewer.id, buyer_id=room["buyer_id"], seller_id=room["seller_id"])
            db.rollback()
            return result, False
        status = derive_chat_status(room["application_status"], room["request_status"])
        if status not in {"active", "matched"}:
            db.rollback()
            raise ChatRoomClosed
        message = message_repository.insert_message(
            db,
            room_id=room_id,
            sender_id=viewer.id,
            seq=message_repository.next_seq(db, room_id),
            client_message_id=payload.client_message_id,
            body=payload.body,
        )
        result = _dto_view(message, viewer_id=viewer.id, buyer_id=room["buyer_id"], seller_id=room["seller_id"])
        db.commit()
        return result, True
    except (ChatRoomNotFound, ChatRoomClosed):
        raise
    except IntegrityError as exc:
        db.rollback()
        if getattr(getattr(exc, "orig", None), "diag", None) and exc.orig.diag.constraint_name == "uq_chat_messages_client_id":
            try:
                existing = message_repository.find_by_client_id(
                    db, room_id=room_id, sender_id=viewer.id, client_message_id=payload.client_message_id
                )
                if existing is not None:
                    state = room_repository.get_state_for_participant(db, room_id=room_id, viewer_id=viewer.id)
                    if state is not None:
                        return _dto_view(existing, viewer_id=viewer.id, buyer_id=state.buyer_id, seller_id=state.seller_id), False
            except SQLAlchemyError:
                db.rollback()
        log_database_failure("send_message", exc, settings)
        raise ServiceUnavailable from None
    except (OperationalError, SQLAlchemyError) as exc:
        db.rollback()
        log_database_failure("send_message", exc, settings)
        raise ServiceUnavailable from None
    except Exception:
        db.rollback()
        raise


def list_chat_rooms(db: Session, *, viewer: User, limit: int, settings: Settings) -> dict:
    try:
        rows = room_repository.list_for_user(db, viewer_id=viewer.id, limit=limit)
        has_more = len(rows) > limit
        items = []
        for room, application, request, counterpart_id, counterpart_email, viewer_role, last_body, last_sender_id, last_created_at in rows[:limit]:
            status = derive_chat_status(application.status, request.status)
            items.append({
                "id": room.id,
                "viewer_role": viewer_role,
                "chat_status": status,
                "request": {"id": request.id, "title": request.title, "status": request.status},
                "counterpart": {"id": counterpart_id, "masked_email": mask_email(counterpart_email)},
                "last_message": None if last_body is None else {
                    "body": last_body[:100],
                    "sender_role": "buyer" if last_sender_id == application.buyer_id else "seller",
                    "created_at": last_created_at,
                },
                "last_activity_at": last_created_at or room.created_at,
            })
        return {"items": items, "has_more": has_more}
    except SQLAlchemyError as exc:
        db.rollback()
        log_database_failure("list_chat_rooms", exc, settings)
        raise ServiceUnavailable from None
