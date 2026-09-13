from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db.models import AuthSession, User


def get_session_user(db: Session, token_hash: str) -> tuple[AuthSession, User] | None:
    return db.execute(
        select(AuthSession, User).join(User, User.id == AuthSession.user_id).where(AuthSession.token_hash == token_hash)
    ).one_or_none()


def delete_by_hash(db: Session, token_hash: str) -> None:
    db.execute(delete(AuthSession).where(AuthSession.token_hash == token_hash))
