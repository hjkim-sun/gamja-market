from __future__ import annotations

import uuid
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import ChatMessage


def find_by_client_id(db: Session, *, room_id: UUID, sender_id: UUID, client_message_id: UUID) -> ChatMessage | None:
    return db.scalar(
        select(ChatMessage).where(
            ChatMessage.room_id == room_id,
            ChatMessage.sender_id == sender_id,
            ChatMessage.client_message_id == client_message_id,
        )
    )


def max_seq(db: Session, room_id: UUID) -> int:
    return int(db.scalar(select(func.coalesce(func.max(ChatMessage.seq), 0)).where(ChatMessage.room_id == room_id)) or 0)


def next_seq(db: Session, room_id: UUID) -> int:
    return max_seq(db, room_id) + 1


def insert_message(
    db: Session, *, room_id: UUID, sender_id: UUID, seq: int, client_message_id: UUID, body: str
) -> ChatMessage:
    message = ChatMessage(
        id=uuid.uuid4(), room_id=room_id, sender_id=sender_id, seq=seq,
        client_message_id=client_message_id, body=body,
    )
    db.add(message)
    db.flush()
    db.refresh(message)
    return message


def list_after(db: Session, *, room_id: UUID, after_seq: int, limit: int) -> list[ChatMessage]:
    return list(
        db.scalars(
            select(ChatMessage).where(ChatMessage.room_id == room_id, ChatMessage.seq > after_seq)
            .order_by(ChatMessage.seq.asc()).limit(limit + 1)
        )
    )


def list_latest(db: Session, *, room_id: UUID, limit: int) -> list[ChatMessage]:
    rows = list(
        db.scalars(
            select(ChatMessage).where(ChatMessage.room_id == room_id)
            .order_by(ChatMessage.seq.desc()).limit(limit + 1)
        )
    )
    return list(reversed(rows))
