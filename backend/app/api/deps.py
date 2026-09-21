from __future__ import annotations

import re

from fastapi import Depends, Request, Response
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.core.config import Settings, get_settings
from app.core.security import hash_session_token, utcnow
from app.db.models import User
from app.db.session import get_db
from app.repositories.sessions import get_session_user
from app.services.auth import remove_expired_session
from app.services.errors import ServiceUnavailable

_SESSION_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{43,128}$")


def expire_session_cookie(response: Response, settings: Settings) -> None:
    response.set_cookie(
        key=settings.session_cookie_name, value="", max_age=0, expires=0, path="/", httponly=True,
        secure=settings.session_cookie_secure, samesite="lax"
    )


def set_session_cookie(response: Response, token: str, settings: Settings) -> None:
    response.set_cookie(
        key=settings.session_cookie_name, value=token, max_age=settings.session_ttl_seconds, path="/", httponly=True,
        secure=settings.session_cookie_secure, samesite="lax"
    )


def request_session_token(request: Request, settings: Settings) -> str | None:
    token = request.cookies.get(settings.session_cookie_name)
    return token if token is not None and _SESSION_TOKEN_RE.fullmatch(token) else None


def require_auth_post_request(request: Request, settings: Settings = Depends(get_settings)) -> None:
    origin = request.headers.get("origin")
    if origin not in settings.auth_allowed_origins or request.headers.get("x-requested-with") != "gamja-market":
        raise ApiError(403, "INVALID_ORIGIN")
    content_type = request.headers.get("content-type", "")
    if content_type.split(";", 1)[0].strip().lower() != "application/json":
        raise ApiError(415, "UNSUPPORTED_MEDIA_TYPE")


def get_current_user(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> User:
    token = request_session_token(request, settings)
    if token is None:
        expire_session_cookie(response, settings)
        raise ApiError(401, "UNAUTHENTICATED")
    try:
        record = get_session_user(db, hash_session_token(token))
    except SQLAlchemyError:
        db.rollback()
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None
    if record is None:
        expire_session_cookie(response, settings)
        raise ApiError(401, "UNAUTHENTICATED")
    session, user = record
    if session.expires_at <= utcnow():
        try:
            remove_expired_session(db, session)
        except ServiceUnavailable:
            raise ApiError(503, "SERVICE_UNAVAILABLE") from None
        expire_session_cookie(response, settings)
        raise ApiError(401, "UNAUTHENTICATED")
    return user


def get_optional_user(
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> User | None:
    """Return an authenticated viewer for public reads without mutating its cookie."""
    token = request_session_token(request, settings)
    if token is None:
        return None
    try:
        record = get_session_user(db, hash_session_token(token))
    except SQLAlchemyError:
        db.rollback()
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None
    if record is None:
        return None
    session, user = record
    return user if session.expires_at > utcnow() else None
