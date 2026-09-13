from __future__ import annotations

from uuid import UUID

from email_validator import EmailNotValidError, validate_email
from pydantic import BaseModel, ConfigDict, StrictStr, field_validator


class AuthInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _normalize_email(value: str) -> str:
    normalized = value.strip().lower()
    if len(normalized) > 254 or not normalized.isascii():
        raise ValueError("유효한 이메일 주소를 입력해 주세요.")
    try:
        result = validate_email(normalized, check_deliverability=False, allow_smtputf8=False)
    except EmailNotValidError as exc:
        raise ValueError("유효한 이메일 주소를 입력해 주세요.") from exc
    if result.normalized != normalized or not result.normalized.isascii():
        raise ValueError("유효한 이메일 주소를 입력해 주세요.")
    return normalized


def _validate_password(value: str) -> str:
    if not 8 <= len(value) <= 128:
        raise ValueError("비밀번호는 8자 이상 128자 이하여야 합니다.")
    return value


class SignupRequest(AuthInput):
    email: StrictStr
    password: StrictStr
    password_confirmation: StrictStr

    _email = field_validator("email")(_normalize_email)
    _password = field_validator("password")(_validate_password)
    _password_confirmation = field_validator("password_confirmation")(_validate_password)


class LoginRequest(AuthInput):
    email: StrictStr
    password: StrictStr

    _email = field_validator("email")(_normalize_email)
    _password = field_validator("password")(_validate_password)


class LogoutRequest(AuthInput):
    pass


class AuthUser(BaseModel):
    id: UUID
    email: str


class AuthResponse(BaseModel):
    user: AuthUser
