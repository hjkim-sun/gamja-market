from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import PurchaseRequest, User


def create(
    db: Session,
    *,
    buyer_id: UUID,
    title: str,
    category: str,
    description: str,
    price_min: int,
    price_max: int,
    condition: str,
    region: str,
) -> PurchaseRequest:
    request = PurchaseRequest(
        buyer_id=buyer_id,
        title=title,
        category=category,
        description=description,
        price_min=price_min,
        price_max=price_max,
        condition=condition,
        region=region,
        status="open",
    )
    db.add(request)
    db.flush()
    db.refresh(request)
    return request


def get_by_id(db: Session, request_id: UUID) -> tuple[PurchaseRequest, str] | None:
    return db.execute(
        select(PurchaseRequest, User.email)
        .join(User, User.id == PurchaseRequest.buyer_id)
        .where(PurchaseRequest.id == request_id)
    ).one_or_none()


def list_and_count(
    db: Session,
    *,
    q: str | None,
    category: str | None,
    status: str | None,
    sort: str | None,
    page: int,
    page_size: int,
) -> tuple[list[tuple[PurchaseRequest, str]], int]:
    conditions = []
    if q is not None:
        escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        conditions.append(func.lower(PurchaseRequest.title).like(f"%{escaped.lower()}%", escape="\\"))
    if category is not None:
        conditions.append(PurchaseRequest.category == category)
    # This stage exposes only the open filter. Unknown values retain the public all-status view.
    if status == "open":
        conditions.append(PurchaseRequest.status == "open")

    statement = select(PurchaseRequest, User.email).join(User, User.id == PurchaseRequest.buyer_id)
    if conditions:
        statement = statement.where(*conditions)

    if sort == "price":
        statement = statement.order_by(
            PurchaseRequest.price_max.desc(), PurchaseRequest.created_at.desc(), PurchaseRequest.id.desc()
        )
    else:
        # "applicants" has no distinct ordering until the applicants table is introduced.
        statement = statement.order_by(PurchaseRequest.created_at.desc(), PurchaseRequest.id.desc())

    rows = db.execute(statement.offset((page - 1) * page_size).limit(page_size)).all()
    total = db.scalar(select(func.count()).select_from(PurchaseRequest).where(*conditions)) or 0
    return rows, total
