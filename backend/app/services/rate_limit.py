from __future__ import annotations

import hashlib
import math

from sqlalchemy.orm import Session

from app.core import security
from app.core.db_logging import log_database_failure
from app.core.config import Settings
from app.repositories.rate_limits import consume_buckets
from app.services.errors import ServiceUnavailable


def utcnow():
    return security.utcnow()


class RateLimited(Exception):
    def __init__(self, retry_after: int) -> None:
        self.retry_after = retry_after
        super().__init__("authentication rate limit exceeded")


def _bucket_key(action: str, axis: str, value: str) -> str:
    return hashlib.sha256(f"{action}:{axis}:{value}".encode("utf-8")).hexdigest()


def enforce_auth_rate_limit(
    db: Session,
    *,
    action: str,
    client_ip: str,
    email: str | None,
    settings: Settings,
) -> None:
    if not settings.auth_rate_limit_enabled:
        return
    if action == "login":
        window = settings.auth_login_window_seconds
        ip_limit = settings.auth_login_ip_limit
        email_limit = settings.auth_login_email_limit
    elif action == "signup":
        window = settings.auth_signup_window_seconds
        ip_limit = settings.auth_signup_ip_limit
        email_limit = None
    else:
        raise ValueError("unsupported auth rate limit action")

    now = utcnow()
    rejected: list[int] = []
    try:
        ip_key = _bucket_key(action, "ip", client_ip)
        ip_consumed = consume_buckets(
            db,
            bucket_keys=[ip_key],
            now=now,
            window_seconds=window,
        )
        ip_count, ip_window_started_at = ip_consumed[ip_key]
        if ip_count > ip_limit:
            rejected.append(max(1, math.ceil((ip_window_started_at.timestamp() + window) - now.timestamp())))
        elif email_limit is not None:
            normalized_email = (email or "").strip().lower()
            email_key = _bucket_key(action, "email", normalized_email)
            email_consumed = consume_buckets(
                db,
                bucket_keys=[email_key],
                now=now,
                window_seconds=window,
            )
            email_count, email_window_started_at = email_consumed[email_key]
            if email_count > email_limit:
                rejected.append(max(1, math.ceil((email_window_started_at.timestamp() + window) - now.timestamp())))
        db.commit()

    except Exception as exc:
        db.rollback()
        log_database_failure("rate_limit", exc, settings)
        raise ServiceUnavailable from None
    if rejected:
        raise RateLimited(max(rejected))
