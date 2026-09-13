from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import User


def get_by_email(db: Session, email: str) -> User | None:
    return db.scalar(select(User).where(User.email == email))
