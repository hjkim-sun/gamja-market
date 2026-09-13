from __future__ import annotations

from fastapi import HTTPException
from fastapi.responses import JSONResponse


ERROR_MESSAGES = {
    "VALIDATION_ERROR": "입력값을 확인해 주세요.",
    "PASSWORD_MISMATCH": "비밀번호가 일치하지 않습니다.",
    "EMAIL_ALREADY_EXISTS": "이미 가입된 이메일입니다.",
    "INVALID_CREDENTIALS": "이메일 또는 비밀번호를 확인해 주세요.",
    "UNAUTHENTICATED": "인증이 필요합니다.",
    "INVALID_ORIGIN": "허용되지 않은 요청 출처입니다.",
    "UNSUPPORTED_MEDIA_TYPE": "지원하지 않는 콘텐츠 형식입니다.",
    "SERVICE_UNAVAILABLE": "서비스를 일시적으로 사용할 수 없습니다.",
    "INTERNAL_ERROR": "서버 오류가 발생했습니다.",
}


def error_response(status_code: int, code: str, *, fields: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": ERROR_MESSAGES[code], "fields": fields or {}}},
    )


class ApiError(HTTPException):
    def __init__(self, status_code: int, code: str, *, fields: dict[str, str] | None = None) -> None:
        super().__init__(status_code=status_code, detail={"code": code, "fields": fields or {}})


def error_from_exception(exc: ApiError) -> JSONResponse:
    return error_response(exc.status_code, exc.detail["code"], fields=exc.detail["fields"])
