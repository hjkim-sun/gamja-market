from __future__ import annotations

import itertools
import os
import secrets
import time
from collections.abc import Iterator
from contextlib import ExitStack
from pathlib import Path
from typing import Literal

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.pool import NullPool

os.environ.setdefault("AUTH_ALLOWED_ORIGINS", '["http://localhost:3000"]')
os.environ.setdefault("SESSION_COOKIE_SECURE", "false")

from app.core.config import Settings, get_settings


BACKEND_ROOT = Path(__file__).parents[1]
ALEMBIC_INI = BACKEND_ROOT / "alembic.ini"
LOCAL_DATABASE_HOSTS = {"127.0.0.1", "localhost", "::1"}
_test_counter = itertools.count(1)


def assert_local_test_database(url: str) -> None:
    """Stop before any DB work if a test URL does not target loopback."""

    if make_url(url).host not in LOCAL_DATABASE_HOSTS:
        pytest.exit("테스트 DB가 로컬이 아닙니다(host 분류: remote)", returncode=2)


def classify_revision_state(current: set[str], known: set[str]) -> Literal["ok", "unknown"]:
    return "unknown" if current - known else "ok"


# Tests must never inherit backend/.env's remote MIGRATION_DATABASE_URL. Read the
# runtime URL once, validate it without displaying it, and force Alembic to it.
_runtime_database_url = Settings().database_url
assert_local_test_database(_runtime_database_url)
os.environ["MIGRATION_DATABASE_URL"] = _runtime_database_url
get_settings.cache_clear()
assert_local_test_database(get_settings().migration_database_url)


def _alembic_config() -> Config:
    config = Config(str(ALEMBIC_INI))
    sibling_dir = os.environ.get("GAMJA_SIBLING_REVISION_DIR")
    if sibling_dir:
        config.set_main_option(
            "version_locations",
            os.pathsep.join((str(BACKEND_ROOT / "migrations" / "versions"), sibling_dir)),
        )
    return config


def _explicit_migration_target(config: Config) -> str:
    known = {revision.revision for revision in ScriptDirectory.from_config(config).walk_revisions()}
    # The RED owner runs before 0003 exists. Never use head/heads: advance only to
    # the latest revision explicitly known to this approved feature sequence.
    if "0003_seller_applications" in known:
        return "0003_seller_applications"
    return "0002_create_purchase_requests"


@pytest.fixture(scope="session", autouse=True)
def migrate_database() -> None:
    config = _alembic_config()
    known = {revision.revision for revision in ScriptDirectory.from_config(config).walk_revisions()}
    engine = create_engine(_runtime_database_url, poolclass=NullPool)
    try:
        with engine.connect() as connection:
            has_version_table = bool(
                connection.scalar(text("SELECT to_regclass('public.alembic_version') IS NOT NULL"))
            )
            current = (
                set(connection.scalars(text("SELECT version_num FROM alembic_version")))
                if has_version_table
                else set()
            )
    finally:
        engine.dispose()

    unknown = current - known
    if classify_revision_state(current, known) == "unknown":
        pytest.exit(
            "공유 DB에 이 worktree가 모르는 revision이 있습니다: "
            f"{', '.join(sorted(unknown))}. spec 06 §8.3 절차를 따르세요"
            "(stamp/downgrade 금지)",
            returncode=3,
        )
    command.upgrade(config, _explicit_migration_target(config))


@pytest.fixture(scope="session")
def run_ns() -> str:
    return f"{time.time_ns():x}{secrets.token_hex(3)}"


@pytest.fixture
def test_ns(run_ns: str) -> str:
    return f"{run_ns}t{next(_test_counter):04x}"


def ns_email(test_ns: str, label: str) -> str:
    email = f"t4-{test_ns}-{label}@example.com"
    assert len(email.partition("@")[0]) <= 64
    return email


def ns_title(test_ns: str, text_value: str) -> str:
    prefix = f"[{test_ns}] "
    return prefix + text_value[: 60 - len(prefix)]


@pytest.fixture(scope="session")
def db_engine() -> Iterator[Engine]:
    engine = create_engine(_runtime_database_url, poolclass=NullPool)
    try:
        yield engine
    finally:
        engine.dispose()


@pytest.fixture
def rollback_connection(db_engine: Engine) -> Iterator[Connection]:
    connection = db_engine.connect()
    transaction = connection.begin()
    try:
        yield connection
    finally:
        if transaction.is_active:
            transaction.rollback()
        connection.close()


@pytest.fixture
def owned_request_ids() -> list[str]:
    return []


@pytest.fixture
def wait_until_blocked_by(db_engine: Engine):
    def wait(controller_pid: int, timeout: float = 5.0) -> int:
        deadline = time.monotonic() + timeout
        query = text(
            "SELECT pid, wait_event_type, wait_event "
            "FROM pg_stat_activity "
            "WHERE :controller_pid = ANY(pg_blocking_pids(pid))"
        )
        while time.monotonic() < deadline:
            with db_engine.connect() as observer:
                rows = observer.execute(query, {"controller_pid": controller_pid}).mappings()
                for row in rows:
                    if row["wait_event_type"] == "Lock":
                        return int(row["pid"])
            time.sleep(0.02)
        pytest.fail("제한 시간 안에 제어 커넥션에 의한 PostgreSQL Lock 대기를 관측하지 못했습니다")

    return wait


@pytest.fixture
def client(test_ns: str) -> Iterator[TestClient]:
    from app.main import app

    with TestClient(app, raise_server_exceptions=False) as test_client:
        # Existing regression helpers read this to avoid fixed identities while
        # keeping individual test signatures compact.
        test_client.test_ns = test_ns  # type: ignore[attr-defined]
        yield test_client


@pytest.fixture
def client_factory():
    from app.main import app

    with ExitStack() as stack:
        def create() -> TestClient:
            return stack.enter_context(TestClient(app, raise_server_exceptions=False))

        yield create


@pytest.fixture
def post_headers() -> dict[str, str]:
    return {
        "Origin": "http://localhost:3000",
        "X-Requested-With": "gamja-market",
        "Content-Type": "application/json",
    }
