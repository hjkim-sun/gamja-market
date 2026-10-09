from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.core.config import get_settings


def create_session_factory(database_url: str | None = None, settings=None) -> sessionmaker[Session]:
    settings = settings or get_settings()
    options = {}
    if settings.database_disable_prepared_statements:
        options["connect_args"] = {"prepare_threshold": None}
    if settings.database_pool_mode == "queue":
        options.update(
            pool_size=settings.database_pool_size,
            max_overflow=settings.database_max_overflow,
            pool_recycle=settings.database_pool_recycle_seconds,
            pool_timeout=settings.database_pool_timeout_seconds,
            pool_pre_ping=True,
        )
    else:
        options["poolclass"] = NullPool
    engine = create_engine(database_url or settings.database_url, **options)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


SessionLocal = create_session_factory()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
