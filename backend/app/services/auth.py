from __future__ import annotations

from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.security import (
    hash_password,
    hash_session_token,
    new_session_token,
    session_expiry,
    verify_dummy_password,
    verify_password,
)
from app.db.models import AuthSession, User
from app.repositories.sessions import delete_by_hash
from app.repositories.users import get_by_email


class EmailAlreadyExists(Exception):
    pass


class InvalidCredentials(Exception):
    pass


class ServiceUnavailable(Exception):
    pass


def _is_users_email_unique_violation(exc: IntegrityError) -> bool:
    original = exc.orig
    diagnostic = getattr(original, "diag", None)
    return getattr(original, "sqlstate", None) == "23505" and getattr(diagnostic, "constraint_name", None) == "uq_users_email"


def signup(db: Session, *, email: str, password: str, old_token: str | None, settings: Settings) -> tuple[User, str]:
    """Create user and replacement session atomically after endpoint validation."""
    try:
        if get_by_email(db, email) is not None:
            db.rollback()
            raise EmailAlreadyExists
        # End the read transaction before expensive hashing; the INSERT still handles races.
        db.rollback()
        password_hash = hash_password(password)
        token = new_session_token()
        user = User(email=email, password_hash=password_hash)
        db.add(user)
        db.flush()
        if old_token is not None:
            delete_by_hash(db, hash_session_token(old_token))
        db.add(AuthSession(token_hash=hash_session_token(token), user_id=user.id, expires_at=session_expiry(settings)))
        db.commit()
        return user, token
    except IntegrityError as exc:
        db.rollback()
        if _is_users_email_unique_violation(exc):
            raise EmailAlreadyExists from None
        raise ServiceUnavailable from None
    except SQLAlchemyError:
        db.rollback()
        raise ServiceUnavailable from None


def login(db: Session, *, email: str, password: str, old_token: str | None, settings: Settings) -> tuple[User, str]:
    try:
        user = get_by_email(db, email)
    except SQLAlchemyError:
        db.rollback()
        raise ServiceUnavailable from None
    if user is None:
        db.rollback()
        verify_dummy_password(password)
        raise InvalidCredentials
    if not verify_password(password, user.password_hash):
        db.rollback()
        raise InvalidCredentials
    try:
        token = new_session_token()
        if old_token is not None:
            delete_by_hash(db, hash_session_token(old_token))
        db.add(AuthSession(token_hash=hash_session_token(token), user_id=user.id, expires_at=session_expiry(settings)))
        db.commit()
        return user, token
    except SQLAlchemyError:
        db.rollback()
        raise ServiceUnavailable from None


def logout(db: Session, *, token: str | None) -> None:
    if token is None:
        return
    try:
        delete_by_hash(db, hash_session_token(token))
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        raise ServiceUnavailable from None


def remove_expired_session(db: Session, session: AuthSession) -> None:
    try:
        db.delete(session)
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        raise ServiceUnavailable from None
