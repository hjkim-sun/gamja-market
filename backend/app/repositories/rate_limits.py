from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import case
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.db.models import AuthRateLimit


def consume_buckets(
    db: Session,
    *,
    bucket_keys: list[str],
    now: datetime,
    window_seconds: int,
) -> dict[str, tuple[int, datetime]]:
    """Atomically consume sorted fixed-window buckets in one statement."""
    if not bucket_keys:
        return {}
    ordered_keys = sorted(bucket_keys)
    table = AuthRateLimit.__table__
    expired = table.c.window_started_at <= now - timedelta(seconds=window_seconds)
    statement = insert(table).values([
        {
            "bucket_key": bucket_key,
            "window_started_at": now,
            "hit_count": 1,
            "updated_at": now,
        }
        for bucket_key in ordered_keys
    ]).on_conflict_do_update(
        index_elements=[table.c.bucket_key],
        set_={
            "window_started_at": case((expired, now), else_=table.c.window_started_at),
            "hit_count": case((expired, 1), else_=table.c.hit_count + 1),
            "updated_at": now,
        },
    ).returning(table.c.bucket_key, table.c.hit_count, table.c.window_started_at)
    rows = db.execute(statement).all()
    return {row.bucket_key: (int(row.hit_count), row.window_started_at) for row in rows}
