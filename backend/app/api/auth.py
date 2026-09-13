from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy.orm import Session

from app.api.deps import (
    expire_session_cookie,
    get_current_user,
    get_db,
    request_session_token,
    require_auth_post_request,
    set_session_cookie,
)
from app.api.errors import ApiError
from app.core.config import Settings, get_settings
from app.db.models import User
from app.schemas.auth import AuthResponse, AuthUser, LoginRequest, LogoutRequest, SignupRequest
from app.services.auth import EmailAlreadyExists, InvalidCredentials, ServiceUnavailable, login, logout, signup

router = APIRouter(prefix="/api/auth", tags=["auth"])


def user_response(user: User) -> AuthResponse:
    return AuthResponse(user=AuthUser(id=user.id, email=user.email))


@router.post("/signup", response_model=AuthResponse, status_code=status.HTTP_201_CREATED, dependencies=[Depends(require_auth_post_request)])
def signup_endpoint(
    payload: SignupRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> AuthResponse:
    # This comparison follows type/length validation and precedes all database and hashing work.
    if payload.password != payload.password_confirmation:
        raise ApiError(422, "PASSWORD_MISMATCH", fields={"password_confirmation": "비밀번호가 일치하지 않습니다."})
    try:
        user, token = signup(
            db,
            email=payload.email,
            password=payload.password,
            old_token=request_session_token(request, settings),
            settings=settings,
        )
    except EmailAlreadyExists:
        raise ApiError(409, "EMAIL_ALREADY_EXISTS", fields={"email": "이미 가입된 이메일입니다."}) from None
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None
    set_session_cookie(response, token, settings)
    return user_response(user)


@router.post("/login", response_model=AuthResponse, dependencies=[Depends(require_auth_post_request)])
def login_endpoint(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> AuthResponse:
    try:
        user, token = login(
            db,
            email=payload.email,
            password=payload.password,
            old_token=request_session_token(request, settings),
            settings=settings,
        )
    except InvalidCredentials:
        raise ApiError(401, "INVALID_CREDENTIALS") from None
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None
    set_session_cookie(response, token, settings)
    return user_response(user)


@router.get("/me", response_model=AuthResponse)
def me_endpoint(user: User = Depends(get_current_user)) -> AuthResponse:
    return user_response(user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_auth_post_request)])
def logout_endpoint(
    _: LogoutRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> Response:
    try:
        logout(db, token=request_session_token(request, settings))
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None
    expire_session_cookie(response, settings)
    return Response(status_code=status.HTTP_204_NO_CONTENT, headers=dict(response.headers))
