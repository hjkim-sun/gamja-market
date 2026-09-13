from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.core.config import get_settings


def create_session_factory(database_url: str | None = None) -> sessionmaker[Session]:
    engine = create_engine(database_url or get_settings().database_url, poolclass=NullPool, pool_pre_ping=True)
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


SessionLocal = create_session_factory()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
