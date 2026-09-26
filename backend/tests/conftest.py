from __future__ import annotations

import os
from collections.abc import Callable, Iterator
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

os.environ.setdefault("AUTH_ALLOWED_ORIGINS", '["http://localhost:3000"]')
os.environ.setdefault("SESSION_COOKIE_SECURE", "false")


@pytest.fixture(scope="session", autouse=True)
def ensure_schema() -> None:
    """Verify prerequisites and apply only the stage-5 additive DDL when present.

    This deliberately does not invoke Alembic or inspect/update alembic_version:
    the local database is shared with other curriculum worktrees.
    """
    from app.core.config import get_settings
    from tests.support.schema import ensure_additive_schema

    engine = create_engine(get_settings().database_url)
    try:
        ensure_additive_schema(engine)
    finally:
        engine.dispose()


@pytest.fixture
def run_tag() -> str:
    return f"t{uuid4().hex[:10]}"


@pytest.fixture
def unique_email(run_tag: str) -> Callable[[str], str]:
    return lambda prefix="buyer": f"{prefix}-{run_tag}@example.com"


@pytest.fixture
def client() -> Iterator[TestClient]:
    from app.main import app

    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


@pytest.fixture
def post_headers() -> dict[str, str]:
    return {
        "Origin": "http://localhost:3000",
        "X-Requested-With": "gamja-market",
        "Content-Type": "application/json",
    }


@pytest.fixture
def upload_headers(post_headers: dict[str, str]) -> dict[str, str]:
    return {**post_headers, "Content-Type": "image/jpeg"}


@pytest.fixture
def photo_storage():
    """Override the future storage dependency without contacting Supabase."""
    from app.api.deps import get_photo_storage
    from app.main import app
    from tests.support.fake_storage import FakePhotoStorage

    storage = FakePhotoStorage()
    app.dependency_overrides[get_photo_storage] = lambda: storage
    try:
        yield storage
    finally:
        app.dependency_overrides.pop(get_photo_storage, None)
