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
        buckets = [
            ("ip", client_ip, settings.auth_login_ip_limit),
            ("email", (email or "").strip().lower(), settings.auth_login_email_limit),
        ]
    elif action == "signup":
        window = settings.auth_signup_window_seconds
        buckets = [("ip", client_ip, settings.auth_signup_ip_limit)]
    else:
        raise ValueError("unsupported auth rate limit action")
    now = utcnow()
    rejected: list[int] = []
    try:
        keyed_limits = sorted(
            (_bucket_key(action, axis, value), limit)
            for axis, value, limit in buckets
        )
        consumed = consume_buckets(
            db,
            bucket_keys=[bucket_key for bucket_key, _ in keyed_limits],
            now=now,
            window_seconds=window,
        )
        db.commit()
        for bucket_key, limit in keyed_limits:
            count, window_started_at = consumed[bucket_key]
            if count > limit:
                rejected.append(max(1, math.ceil((window_started_at.timestamp() + window) - now.timestamp())))
    except Exception as exc:
        db.rollback()
        log_database_failure("rate_limit", exc, settings)
        raise ServiceUnavailable from None
    if rejected:
        raise RateLimited(max(rejected))
