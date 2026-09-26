from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.auth import router as auth_router
from app.api.applications import chat_rooms_router, router as applications_router
from app.api.requests import router as requests_router
from app.api.deps import expire_session_cookie
from app.core.config import get_settings
from app.api.errors import ApiError, error_from_exception, error_response

app = FastAPI(title="Gamja Market API")
app.include_router(auth_router)
app.include_router(requests_router)
app.include_router(applications_router)
app.include_router(chat_rooms_router)


def _api_no_store(response: JSONResponse, path: str) -> JSONResponse:
    if path.startswith(("/api/auth/", "/api/requests", "/api/chat-rooms")):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.middleware("http")
async def auth_no_store(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith(("/api/auth/", "/api/requests", "/api/chat-rooms")):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(ApiError)
async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    response = error_from_exception(exc)
    if exc.detail["code"] == "UNAUTHENTICATED":
        expire_session_cookie(response, get_settings())
    return _api_no_store(response, _.url.path)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    request_fields = {
        "title": "제목은 2자 이상 60자 이하로 입력해 주세요.",
        "category": "카테고리를 선택해 주세요.",
        "description": "원하는 스펙은 10자 이상 1000자 이하로 입력해 주세요.",
        "priceMin": "최소가는 0원 이상으로 입력해 주세요.",
        "priceMax": "최대가는 최소가보다 크거나 같아야 합니다.",
        "condition": "희망 상태를 선택해 주세요.",
        "region": "거래 지역을 입력해 주세요.",
        "page": "입력값을 확인해 주세요.",
        "pageSize": "입력값을 확인해 주세요.",
        "q": "입력값을 확인해 주세요.",
        "sort": "입력값을 확인해 주세요.",
        "status": "입력값을 확인해 주세요.",
    }
    auth_fields = {"email": "입력값을 확인해 주세요.", "password": "입력값을 확인해 주세요.", "password_confirmation": "입력값을 확인해 주세요."}
    application_fields = {
        "offerPrice": "제시가는 0원 이상 10억원 이하의 정수로 입력해 주세요.",
        "message": "지원 메시지는 2자 이상 500자 이하로 입력해 주세요.",
    }
    path = request.url.path
    is_application_path = path.startswith("/api/requests/") and path.endswith("/applications")
    allowed = application_fields if is_application_path else request_fields if path.startswith("/api/requests") else auth_fields
    fields: dict[str, str] = {}
    # Never serialize Pydantic's input/context: they can contain password values.
    for error in exc.errors():
        location = error.get("loc", ())
        field = location[-1] if location else None
        if isinstance(field, str) and field in allowed and field not in fields:
            fields[field] = allowed[field]
    return _api_no_store(error_response(422, "VALIDATION_ERROR", fields=fields), path)


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    if exc.status_code == 415:
        return _api_no_store(error_response(415, "UNSUPPORTED_MEDIA_TYPE"), request.url.path)
    return _api_no_store(error_response(exc.status_code, "INTERNAL_ERROR"), request.url.path)


@app.exception_handler(Exception)
async def unexpected_error_handler(request: Request, _: Exception) -> JSONResponse:
    return _api_no_store(error_response(500, "INTERNAL_ERROR"), request.url.path)
