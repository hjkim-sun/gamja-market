from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from pwdlib import PasswordHash
from pwdlib.hashers.argon2 import Argon2Hasher

from app.core.config import Settings


# Parameters are explicit so deployments do not silently inherit a weaker default.
password_hasher = PasswordHash((Argon2Hasher(memory_cost=65536, time_cost=3, parallelism=4),))
_DUMMY_PASSWORD_HASH = password_hasher.hash("gamja-market-dummy-password")


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return password_hasher.verify(password, password_hash)


def verify_dummy_password(password: str) -> None:
    password_hasher.verify(password, _DUMMY_PASSWORD_HASH)


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def utcnow() -> datetime:
    return datetime.now(UTC)


def session_expiry(settings: Settings) -> datetime:
    return utcnow() + timedelta(seconds=settings.session_ttl_seconds)
