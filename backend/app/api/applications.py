from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, get_optional_user, require_auth_post_request
from app.api.errors import ApiError
from app.core.config import Settings, get_settings
from app.db.models import User
from app.schemas.applications import (
    ApplicationCreate,
    ApplicationListResponse,
    ApplyResponse,
    ChatRoomView,
    MatchCreate,
    MatchResponse,
)
from app.schemas.chat import ChatRoomListResponse, MessageCreate, MessageEnvelope, MessageListParams, MessageListResponse
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
from app.services.matching import (
    ApplicationNotFound,
    NotRequestOwner,
    RequestAlreadyMatched,
    RequestClosed,
    confirm_match,
)
from app.services.chat import ChatRoomClosed, list_chat_rooms, list_messages, send_message


router = APIRouter(prefix="/api/requests", tags=["applications"])
chat_rooms_router = APIRouter(prefix="/api/chat-rooms", tags=["chat-rooms"])


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


@router.post(
    "/{request_id}/match",
    response_model=MatchResponse,
    dependencies=[Depends(require_auth_post_request)],
)
def confirm_match_endpoint(
    request_id: UUID,
    payload: MatchCreate,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> MatchResponse:
    _no_store(response)
    try:
        return confirm_match(
            db, request_id=request_id, application_id=payload.application_id, viewer_id=user.id, settings=settings
        )
    except RequestNotFound:
        raise ApiError(404, "NOT_FOUND") from None
    except ApplicationNotFound:
        raise ApiError(404, "NOT_FOUND") from None
    except NotRequestOwner:
        raise ApiError(403, "NOT_REQUEST_OWNER") from None
    except RequestAlreadyMatched:
        raise ApiError(409, "REQUEST_ALREADY_MATCHED") from None
    except RequestClosed:
        raise ApiError(409, "REQUEST_CLOSED") from None
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None


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


@chat_rooms_router.get("", response_model=ChatRoomListResponse)
def list_chat_rooms_endpoint(
    response: Response,
    limit: int = Query(default=50, ge=1, le=50),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> ChatRoomListResponse:
    _no_store(response)
    try:
        return ChatRoomListResponse.model_validate(list_chat_rooms(db, viewer=user, limit=limit, settings=settings))
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None


@chat_rooms_router.get("/{room_id}/messages", response_model=MessageListResponse)
def list_messages_endpoint(
    room_id: UUID,
    response: Response,
    after_seq: int | None = Query(default=None, alias="afterSeq", ge=0, le=2_147_483_647),
    limit: int | None = Query(default=None, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> MessageListResponse:
    _no_store(response)
    try:
        params = MessageListParams.model_validate(
            {"after_seq": after_seq, "limit": limit if limit is not None else (100 if after_seq is None else 50)}
        )
        return MessageListResponse.model_validate(list_messages(db, room_id=room_id, viewer=user, params=params, settings=settings))
    except ChatRoomNotFound:
        raise ApiError(404, "NOT_FOUND") from None
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None


@chat_rooms_router.post(
    "/{room_id}/messages",
    response_model=MessageEnvelope,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_auth_post_request)],
)
def send_message_endpoint(
    room_id: UUID,
    payload: MessageCreate,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> MessageEnvelope:
    _no_store(response)
    try:
        message, created = send_message(db, room_id=room_id, viewer=user, payload=payload, settings=settings)
        response.status_code = status.HTTP_201_CREATED if created else status.HTTP_200_OK
        return MessageEnvelope(message=message)
    except ChatRoomNotFound:
        raise ApiError(404, "NOT_FOUND") from None
    except ChatRoomClosed:
        raise ApiError(409, "CHAT_ROOM_CLOSED") from None
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None
