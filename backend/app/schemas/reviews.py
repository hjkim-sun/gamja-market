from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, StrictInt, StrictStr, field_validator

from app.schemas.requests import RequestSchema, RequestStatus

ReviewerRole = Literal["buyer", "seller"]


class ReviewCreate(RequestSchema):
    rating: StrictInt = Field(ge=1, le=5)
    body: StrictStr = Field(min_length=2, max_length=500)

    @field_validator("body", mode="before")
    @classmethod
    def trim_body(cls, value: object) -> object:
        if isinstance(value, str):
            value = value.strip()
            if "\x00" in value:
                raise ValueError("body must not contain NUL")
        return value


class PublicReviewView(RequestSchema):
    reviewer_role: ReviewerRole
    rating: int = Field(ge=1, le=5)
    body: str
    created_at: datetime


class ReviewView(PublicReviewView):
    id: UUID


class ReviewEnvelope(RequestSchema):
    review: ReviewView


class TransactionReviewsResponse(RequestSchema):
    request_id: UUID
    request_status: RequestStatus
    completed_at: datetime | None
    items: list[PublicReviewView] = Field(max_length=2)
    viewer_role: ReviewerRole | None
    can_write: bool
    mine: PublicReviewView | None
    received: PublicReviewView | None


class CompletedRequestSummary(RequestSchema):
    id: UUID
    status: Literal["completed"]
    completed_at: datetime


class CompleteResponse(RequestSchema):
    request: CompletedRequestSummary
    accepted_application_id: UUID
    chat_room_id: UUID
