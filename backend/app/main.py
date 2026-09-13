from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.auth import router as auth_router
from app.api.deps import expire_session_cookie
from app.core.config import get_settings
from app.api.errors import ApiError, error_from_exception, error_response

app = FastAPI(title="Gamja Market API")
app.include_router(auth_router)


@app.middleware("http")
async def auth_no_store(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/auth/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(ApiError)
async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    response = error_from_exception(exc)
    if exc.detail["code"] == "UNAUTHENTICATED":
        expire_session_cookie(response, get_settings())
    return response


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    allowed = {"email", "password", "password_confirmation"}
    fields: dict[str, str] = {}
    # Never serialize Pydantic's input/context: they can contain password values.
    for error in exc.errors():
        location = error.get("loc", ())
        field = location[-1] if location else None
        if isinstance(field, str) and field in allowed and field not in fields:
            fields[field] = "입력값을 확인해 주세요."
    return error_response(422, "VALIDATION_ERROR", fields=fields)


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    if exc.status_code == 415:
        return error_response(415, "UNSUPPORTED_MEDIA_TYPE")
    return error_response(exc.status_code, "INTERNAL_ERROR")


@app.exception_handler(Exception)
async def unexpected_error_handler(_: Request, __: Exception) -> JSONResponse:
    return error_response(500, "INTERNAL_ERROR")
