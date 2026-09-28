from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response, status
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db, get_optional_user, get_photo_storage, require_auth_post_request
from app.api.errors import ApiError
from app.core.config import Settings, get_settings
from app.db.models import User
from app.schemas.requests import (
    PurchaseRequestCreate,
    PurchaseRequestDetail,
    PurchaseRequestListResponse,
    RequestCategory,
    RequestListParams,
)
from app.services.errors import ServiceUnavailable
from app.services.requests import InvalidPhotoIds, RequestNotFound, create_request, get_request, list_requests

router = APIRouter(prefix="/api/requests", tags=["requests"])


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


def parse_list_params(
    q: Annotated[str | None, Query(max_length=60)] = None,
    category: RequestCategory | None = None,
    status: str | None = None,
    sort: str | None = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(alias="pageSize", ge=1, le=50)] = 12,
) -> RequestListParams:
    """Apply query normalization while preserving FastAPI's 422 error contract."""
    try:
        return RequestListParams(
            q=q,
            category=category,
            status=status,
            sort=sort,
            page=page,
            page_size=page_size,
        )
    except ValidationError as exc:
        errors = [{**error, "loc": ("query", *error["loc"])} for error in exc.errors()]
        raise RequestValidationError(errors) from None


@router.get("", response_model=PurchaseRequestListResponse)
def list_requests_endpoint(
    response: Response,
    params: Annotated[RequestListParams, Depends(parse_list_params)],
    viewer: User | None = Depends(get_optional_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    storage=Depends(get_photo_storage),
) -> PurchaseRequestListResponse:
    _no_store(response)
    try:
        items, total = list_requests(
            db,
            params=params,
            viewer_id=viewer.id if viewer is not None else None,
            settings=settings,
            namespace=storage.namespace if storage is not None else ("disabled", None),
        )
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None
    return PurchaseRequestListResponse(items=items, total=total, page=params.page, page_size=params.page_size)


@router.get("/{request_id}", response_model=PurchaseRequestDetail)
def get_request_endpoint(
    request_id: UUID,
    response: Response,
    viewer: User | None = Depends(get_optional_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    storage=Depends(get_photo_storage),
) -> PurchaseRequestDetail:
    _no_store(response)
    try:
        result = get_request(
            db,
            request_id=request_id,
            viewer_id=viewer.id if viewer is not None else None,
            settings=settings,
            namespace=storage.namespace if storage is not None else ("disabled", None),
        )
    except RequestNotFound:
        raise ApiError(404, "NOT_FOUND") from None
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None
    return PurchaseRequestDetail.model_validate(result)


@router.post(
    "",
    response_model=PurchaseRequestDetail,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_auth_post_request)],
)
def create_request_endpoint(
    payload: PurchaseRequestCreate,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    storage=Depends(get_photo_storage),
) -> PurchaseRequestDetail:
    _no_store(response)
    try:
        result = create_request(
            db,
            buyer_id=user.id,
            buyer_email=user.email,
            payload=payload,
            settings=settings,
            namespace=storage.namespace if storage is not None else ("disabled", None),
        )
    except InvalidPhotoIds:
        raise ApiError(422, "VALIDATION_ERROR", fields={"photoIds": "사진을 다시 업로드해 주세요."}) from None
    except ServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE") from None
    return PurchaseRequestDetail.model_validate(result)
