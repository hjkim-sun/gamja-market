from __future__ import annotations

import logging

from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import Settings

logger = logging.getLogger(__name__)


def log_database_failure(operation: str, exc: SQLAlchemyError, settings: Settings) -> None:
    """Log a classified database failure without logging a DSN or credentials."""
    original = getattr(exc, "orig", None)
    host = make_url(settings.database_url).host or ""
    endpoint = (
        "supabase_direct" if host.startswith("db.") and host.endswith(".supabase.co")
        else "supabase_pooler" if host.endswith(".pooler.supabase.com")
        else "other"
    )
    detail = str(original).lower() if original is not None else ""
    failure = next(
        (label for marker, label in (
            ("network is unreachable", "network_unreachable"),
            ("connection timed out", "timeout"),
            ("timeout expired", "timeout"),
            ("password authentication failed", "authentication"),
            ("could not translate host name", "dns"),
            ("name or service not known", "dns"),
            ("connection refused", "connection_refused"),
        ) if marker in detail),
        "unknown",
    )
    logger.error(
        "auth.%s database failure: %s, driver=%s, sqlstate=%s, endpoint=%s, failure=%s",
        operation,
        type(exc).__name__,
        type(original).__name__ if original is not None else "none",
        getattr(original, "sqlstate", None),
        endpoint,
        failure,
    )
