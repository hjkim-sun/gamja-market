from __future__ import annotations

import logging
import os
import re
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.auth import router as auth_router
from app.api.applications import chat_rooms_router, router as applications_router
from app.api.request_photos import router as request_photos_router
from app.api.requests import router as requests_router
from app.api.deps import expire_session_cookie
from app.core.config import get_settings
from app.api.errors import ApiError, error_from_exception, error_response

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    if os.environ.get("ENV", "").strip().lower() == "production" and not settings.trust_proxy_ip_headers:
        logger.warning(
            "TRUST_PROXY_IP_HEADERS=false in production; Vercel requests will share the proxy IP rate-limit bucket"
        )
    yield


app = FastAPI(title="Gamja Market API", lifespan=lifespan)
app.include_router(auth_router)
app.include_router(requests_router)
app.include_router(request_photos_router)
app.include_router(applications_router)
app.include_router(chat_rooms_router)


def _api_no_store(response: JSONResponse, path: str) -> JSONResponse:
    if path.startswith("/api/request-photos/files/") and response.status_code != 200:
        response.headers["Cache-Control"] = "no-store"
    if path.startswith(("/api/auth/", "/api/requests", "/api/chat-rooms")) or (
        path.startswith("/api/request-photos") and not path.startswith("/api/request-photos/files/")
    ):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.middleware("http")
async def auth_no_store(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/request-photos/files/") and response.status_code != 200:
        response.headers["Cache-Control"] = "no-store"
    if request.url.path.startswith(("/api/auth/", "/api/requests", "/api/chat-rooms")) or (
        request.url.path.startswith("/api/request-photos")
        and not request.url.path.startswith("/api/request-photos/files/")
    ):
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
        "photoIds": "사진은 서로 다른 5장 이하로 첨부해 주세요.",
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
    match_fields = {"applicationId": "확정할 지원을 선택해 주세요."}
    message_fields = {
        "body": "메시지는 1자 이상 1000자 이하로 입력해 주세요.",
        "clientMessageId": "입력값을 확인해 주세요.",
        "afterSeq": "입력값을 확인해 주세요.",
        "limit": "입력값을 확인해 주세요.",
    }
    chat_list_fields = {"limit": "입력값을 확인해 주세요."}
    path = request.url.path
    if re.fullmatch(r"/api/requests/[^/]+/applications", path):
        allowed = application_fields
    elif re.fullmatch(r"/api/requests/[^/]+/match", path):
        allowed = match_fields
    elif re.fullmatch(r"/api/chat-rooms/[^/]+/messages", path):
        allowed = message_fields
    elif path.startswith("/api/chat-rooms"):
        allowed = chat_list_fields
    elif path.startswith("/api/requests"):
        allowed = request_fields
    else:
        allowed = auth_fields
    fields: dict[str, str] = {}
    # Never serialize Pydantic's input/context: they can contain password values.
    for error in exc.errors():
        location = error.get("loc", ())
        field_location = location[1:] if location and location[0] == "body" else location
        field = next((part for part in field_location if isinstance(part, str) and part in allowed), None)
        if field is None:
            aliases = {"client_message_id": "clientMessageId", "after_seq": "afterSeq"}
            field = next((aliases.get(part) for part in field_location if isinstance(part, str) and aliases.get(part) in allowed), None)
        if isinstance(field, str) and field in allowed and field not in fields:
            fields[field] = allowed[field]
    if not fields and re.fullmatch(r"/api/requests/[^/]+/match", path):
        fields["applicationId"] = match_fields["applicationId"]
    if not fields and re.fullmatch(r"/api/chat-rooms/[^/]+/messages", path) and request.method == "POST":
        fields["body"] = message_fields["body"]
    return _api_no_store(error_response(422, "VALIDATION_ERROR", fields=fields), path)


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    if exc.status_code == 415:
        return _api_no_store(error_response(415, "UNSUPPORTED_MEDIA_TYPE"), request.url.path)
    return _api_no_store(error_response(exc.status_code, "INTERNAL_ERROR"), request.url.path)


@app.exception_handler(Exception)
async def unexpected_error_handler(request: Request, _: Exception) -> JSONResponse:
    return _api_no_store(error_response(500, "INTERNAL_ERROR"), request.url.path)
