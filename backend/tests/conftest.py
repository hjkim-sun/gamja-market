from __future__ import annotations

import os
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

os.environ.setdefault("AUTH_ALLOWED_ORIGINS", '["http://localhost:3000"]')
os.environ.setdefault("SESSION_COOKIE_SECURE", "false")


@pytest.fixture(scope="session", autouse=True)
def migrate_database() -> None:
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    command.upgrade(config, "head")


@pytest.fixture(autouse=True)
def clean_database() -> None:
    from app.core.config import get_settings

    engine = create_engine(get_settings().database_url)
    with engine.begin() as connection:
        # Keep the auth regression suite runnable during the RED stage, before
        # migration 0002 creates purchase_requests. As soon as the table exists,
        # it participates in the same per-test cleanup transaction.
        has_purchase_requests = connection.scalar(
            text("SELECT to_regclass('app_private.purchase_requests') IS NOT NULL")
        )
        tables = "app_private.auth_sessions, app_private.users"
        if has_purchase_requests:
            tables = f"app_private.purchase_requests, {tables}"
        connection.execute(text(f"TRUNCATE {tables} CASCADE"))
    engine.dispose()


@pytest.fixture
def client() -> TestClient:
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
