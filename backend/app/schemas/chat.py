from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, StrictStr, field_validator

from app.schemas.applications import MaskedUser
from app.schemas.requests import RequestSchema


ChatStatus = Literal["active", "matched", "closed"]
ApplicationStatus = Literal["pending", "accepted", "closed"]


class MessageCreate(RequestSchema):
    client_message_id: UUID
    body: StrictStr = Field(min_length=1, max_length=1000)

    @field_validator("body", mode="before")
    @classmethod
    def trim_body(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class MessageView(RequestSchema):
    id: UUID
    seq: int = Field(ge=1)
    sender_role: Literal["buyer", "seller"]
    is_mine: bool
    body: str
    client_message_id: UUID
    created_at: datetime


class MessageRoomState(RequestSchema):
    id: UUID
    chat_status: ChatStatus
    can_send: bool
    application_status: ApplicationStatus
    request_status: Literal["open", "matched", "closed"]


class MessageListResponse(RequestSchema):
    room: MessageRoomState
    items: list[MessageView]
    latest_seq: int = Field(ge=0)
    has_more: bool
    has_older: bool


class MessageEnvelope(RequestSchema):
    message: MessageView


class MessageListParams(RequestSchema):
    after_seq: int | None = Field(default=None, ge=0, le=2_147_483_647)
    limit: int = Field(default=50, ge=1, le=100)


class ChatRequestSummary(RequestSchema):
    id: UUID
    title: str
    status: Literal["open", "matched", "closed"]


class LastMessageView(RequestSchema):
    body: str
    sender_role: Literal["buyer", "seller"]
    created_at: datetime


class ChatRoomListItem(RequestSchema):
    id: UUID
    viewer_role: Literal["buyer", "seller"]
    chat_status: ChatStatus
    request: ChatRequestSummary
    counterpart: MaskedUser
    last_message: LastMessageView | None
    last_activity_at: datetime


class ChatRoomListResponse(RequestSchema):
    items: list[ChatRoomListItem]
    has_more: bool
