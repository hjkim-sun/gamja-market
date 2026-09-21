from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, ValidationInfo, field_validator

REQUEST_CATEGORIES = ("디지털기기", "가전", "가구/인테리어", "의류", "도서", "기타")
RequestCategory = Literal["디지털기기", "가전", "가구/인테리어", "의류", "도서", "기타"]
RequestCondition = Literal["any", "new", "like_new", "used"]
RequestStatus = Literal["open", "matched", "closed"]


def to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class RequestSchema(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        loc_by_alias=True,
        extra="forbid",
    )


def _trim_string(value: str) -> str:
    return value.strip()


class PurchaseRequestCreate(RequestSchema):
    title: StrictStr = Field(min_length=2, max_length=60)
    category: RequestCategory
    description: StrictStr = Field(min_length=10, max_length=1000)
    price_min: StrictInt = Field(ge=0, le=1_000_000_000)
    price_max: StrictInt = Field(ge=0, le=1_000_000_000)
    condition: RequestCondition
    region: StrictStr = Field(min_length=1, max_length=50)

    _title = field_validator("title", mode="before")(_trim_string)
    _description = field_validator("description", mode="before")(_trim_string)
    _region = field_validator("region", mode="before")(_trim_string)

    @field_validator("price_max")
    @classmethod
    def validate_price_range(cls, value: int, info: ValidationInfo) -> int:
        price_min = info.data.get("price_min")
        if isinstance(price_min, int) and value < price_min:
            raise ValueError("priceMax must be greater than or equal to priceMin")
        return value


class RequestListParams(RequestSchema):
    q: str | None = Field(default=None, max_length=60)
    category: RequestCategory | None = None
    status: str | None = None
    sort: str | None = None
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=12, ge=1, le=50)

    @field_validator("q", mode="before")
    @classmethod
    def normalize_query(cls, value: object) -> object:
        if value is None:
            return None
        if not isinstance(value, str):
            return value
        normalized = value.strip()
        if not normalized:
            raise ValueError("q must not be blank")
        return normalized


class PurchaseRequestSummary(RequestSchema):
    id: UUID
    title: str
    category: RequestCategory
    condition: RequestCondition
    price_min: int
    price_max: int
    region: str
    status: RequestStatus
    thumbnail_url: str | None
    applicant_count: Literal[0] = 0
    created_at: datetime
    is_owner: bool


class RequestBuyer(RequestSchema):
    id: UUID
    masked_email: str


class PurchaseRequestDetail(PurchaseRequestSummary):
    description: str
    updated_at: datetime
    buyer: RequestBuyer


class PurchaseRequestListResponse(RequestSchema):
    items: list[PurchaseRequestSummary]
    total: int
    page: int
    page_size: int
