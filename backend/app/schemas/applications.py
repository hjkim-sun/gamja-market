from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, StrictInt, StrictStr, field_validator

from app.schemas.requests import RequestSchema, RequestStatus


class ApplicationCreate(RequestSchema):
    offer_price: StrictInt = Field(ge=0, le=1_000_000_000)
    message: StrictStr = Field(min_length=2, max_length=500)

    @field_validator("message", mode="before")
    @classmethod
    def trim_message(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class MaskedUser(RequestSchema):
    id: UUID
    masked_email: str


class ApplicationView(RequestSchema):
    id: UUID
    request_id: UUID
    seller: MaskedUser
    offer_price: int
    message: str
    chat_room_id: UUID
    created_at: datetime


class ApplicationListResponse(RequestSchema):
    viewer_role: Literal["owner", "applicant", "member", "anonymous"]
    applicant_count: int = Field(ge=0)
    items: list[ApplicationView]


class ChatRoomRequestSummary(RequestSchema):
    id: UUID
    title: str
    status: RequestStatus
    price_min: int
    price_max: int


class ChatRoomView(RequestSchema):
    id: UUID
    application_id: UUID
    viewer_role: Literal["buyer", "seller"]
    request: ChatRoomRequestSummary
    buyer: MaskedUser
    seller: MaskedUser
    offer_price: int
    application_message: str
    created_at: datetime


class ApplyResponse(RequestSchema):
    application: ApplicationView
    chat_room: ChatRoomView
