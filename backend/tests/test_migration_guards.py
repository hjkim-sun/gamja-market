from __future__ import annotations

import pytest

import conftest
from conftest import assert_local_test_database, classify_revision_state


@pytest.mark.parametrize(
    "url",
    [
        "postgresql+psycopg://user:secret@127.0.0.1:5432/gamja",
        "postgresql+psycopg://user:secret@localhost:5432/gamja",
        "postgresql+psycopg://user:secret@[::1]:5432/gamja",
    ],
)
def test_local_database_guard_accepts_loopback(url: str) -> None:
    assert_local_test_database(url)


def test_local_database_guard_rejects_remote_without_leaking_url(monkeypatch) -> None:
    class GuardExit(Exception):
        pass

    captured: dict[str, object] = {}

    def fake_exit(message: str, *, returncode: int) -> None:
        captured.update(message=message, returncode=returncode)
        raise GuardExit

    monkeypatch.setattr(conftest.pytest, "exit", fake_exit)
    remote = "postgresql+psycopg://secret-user:secret-password@db.example.invalid/gamja"
    with pytest.raises(GuardExit):
        assert_local_test_database(remote)

    assert captured == {
        "message": "테스트 DB가 로컬이 아닙니다(host 분류: remote)",
        "returncode": 2,
    }
    assert "secret-user" not in str(captured)
    assert "secret-password" not in str(captured)
    assert "db.example.invalid" not in str(captured)


def test_revision_state_classification() -> None:
    known = {"0001_create_auth_tables", "0002_create_purchase_requests"}
    assert classify_revision_state(set(), known) == "ok"
    assert classify_revision_state({"0002_create_purchase_requests"}, known) == "ok"
    assert classify_revision_state({"0003_photo"}, known) == "unknown"
