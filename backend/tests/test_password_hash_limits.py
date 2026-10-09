"""Behavioral coverage for bounded Argon2 execution and transaction release."""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient


def test_hash_concurrency_never_exceeds_limit(monkeypatch):
    from app.core import security

    active = 0
    maximum = 0
    lock = threading.Lock()

    def slow_verify(_password, _encoded):
        nonlocal active, maximum
        with lock:
            active += 1
            maximum = max(maximum, active)
        time.sleep(0.04)
        with lock:
            active -= 1
        return True

    monkeypatch.setattr(security.password_hasher, "verify", slow_verify)
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _: security.verify_password("pw", "hash"), range(6)))
    assert results == [True] * 6
    assert maximum <= security.PASSWORD_HASH_CONCURRENCY == 2


def test_hash_slot_timeout_maps_to_503(client, post_headers, monkeypatch, test_ns):
    from app.core import security
    import app.services.auth as auth_service

    monkeypatch.setattr(security, "PASSWORD_HASH_WAIT_SECONDS", 0.01)
    slots = [security._hash_slots.acquire(blocking=False) for _ in range(security.PASSWORD_HASH_CONCURRENCY)]
    assert all(slots)
    try:
        login = client.post(
            "/api/auth/login",
            headers=post_headers,
            json={"email": f"missing-{test_ns}@example.com", "password": "potato-pass-123"},
        )
        assert login.status_code == 503
        assert login.json()["error"]["code"] == "SERVICE_UNAVAILABLE"

        monkeypatch.setattr(auth_service, "hash_password", lambda _password: (_ for _ in ()).throw(security.PasswordHashBusy()))
        signup = client.post(
            "/api/auth/signup",
            headers=post_headers,
            json={"email": f"signup-{test_ns}@example.com", "password": "potato-pass-123", "password_confirmation": "potato-pass-123"},
        )
        assert signup.status_code == 503
        assert signup.json()["error"]["code"] == "SERVICE_UNAVAILABLE"
    finally:
        for acquired in reversed(slots):
            if acquired:
                security._hash_slots.release()


def test_login_releases_transaction_before_verify(client, post_headers, unique_email, monkeypatch):
    from app.api.deps import get_db
    from app.db.session import create_session_factory
    from app.main import app
    import app.services.auth as auth_service

    email = unique_email("transaction-boundary")
    sessions = []
    session_factory = create_session_factory()

    def capture_db():
        session = session_factory()
        sessions.append(session)
        try:
            yield session
        finally:
            session.close()

    monkeypatch.setattr(auth_service, "hash_password", lambda _password: "test-password-hash")
    transaction_states = []
    def verify_without_open_transaction(_password, _encoded):
        transaction_states.append(sessions[-1].in_transaction())
        return not transaction_states[-1]
    monkeypatch.setattr(auth_service, "verify_password", verify_without_open_transaction)
    app.dependency_overrides[get_db] = capture_db
    try:
        signup = client.post(
            "/api/auth/signup",
            headers=post_headers,
            json={"email": email, "password": "potato-pass-123", "password_confirmation": "potato-pass-123"},
        )
        assert signup.status_code == 201, signup.text
        client.cookies.clear()
        login = client.post(
            "/api/auth/login",
            headers=post_headers,
            json={"email": email, "password": "potato-pass-123"},
        )
        assert login.status_code == 200, login.text
        assert login.json()["user"]["email"] == email
        assert transaction_states == [False]
    finally:
        app.dependency_overrides.pop(get_db, None)
        for session in sessions:
            session.close()
        session_factory.kw["bind"].dispose()
