from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, get_optional_user, require_auth_post_request
from app.api.errors import ApiError
from app.core.config import Settings, get_settings
from app.db.models import User
from app.schemas.applications import ApplicationCreate, ApplicationListResponse, ApplyResponse, ChatRoomView
from app.services.applications import (
    AlreadyApplied,
    ChatRoomNotFound,
    RequestNotOpen,
    SelfApplicationForbidden,
    apply_to_request,
    get_chat_room,
    list_applications,
)
from app.services.errors import ServiceUnavailable
from app.services.requests import RequestNotFound


router = APIRouter(prefix="/api/requests", tags=["applications"])
chat_rooms_router = APIRouter(prefix="/api/chat-rooms", tags=["chat-rooms"])


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


@router.post(
    "/{request_id}/applications",
    response_model=ApplyResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_auth_post_request)],
)
def apply_to_request_endpoint(
    request_id: UUID,
    payload: ApplicationCreate,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ApplyResponse:
    _no_store(response)
    try:
        result = apply_to_request(db, request_id=request_id, seller=user, payload=payload, settings=settings)
    except RequestNotFound:
        raise ApiError(404, "NOT_FOUND") from None
    except SelfApplicationForbidden:
        raise ApiError(403, "SELF_APPLICATION_FORBIDDEN") from None
    except RequestNotOpen:
        raise ApiError(409, "REQUEST_NOT_OPEN") from None
    except AlreadyApplied:
        raise ApiError(409, "ALREADY_APPLIED") from None
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None
    return result


@router.get("/{request_id}/applications", response_model=ApplicationListResponse)
def list_applications_endpoint(
    request_id: UUID,
    response: Response,
    viewer: User | None = Depends(get_optional_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ApplicationListResponse:
    _no_store(response)
    try:
        result = list_applications(db, request_id=request_id, viewer_id=viewer.id if viewer else None, settings=settings)
    except RequestNotFound:
        raise ApiError(404, "NOT_FOUND") from None
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None
    return ApplicationListResponse.model_validate(result)


@chat_rooms_router.get("/{room_id}", response_model=ChatRoomView)
def get_chat_room_endpoint(
    room_id: UUID,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ChatRoomView:
    _no_store(response)
    try:
        result = get_chat_room(db, room_id=room_id, viewer=user, settings=settings)
    except ChatRoomNotFound:
        raise ApiError(404, "NOT_FOUND") from None
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None
    return ChatRoomView.model_validate(result)
