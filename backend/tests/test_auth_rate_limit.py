"""HTTP and repository behavior for the PostgreSQL-backed auth rate limiter."""
from __future__ import annotations

import hashlib
import ipaddress
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from conftest import ns_email

LOGIN_URL = "/api/auth/login"
SIGNUP_URL = "/api/auth/signup"
MESSAGE = "요청이 너무 많아요. 잠시 후 다시 시도해 주세요."


def _ip(test_ns: str, offset: int = 0) -> str:
    # The API groups IPv6 clients by /64. Give each test namespace and logical
    # IP offset its own prefix so persistent database buckets cannot collide.
    digest = hashlib.sha256(f"{test_ns}:{offset}".encode()).hexdigest()
    return f"2001:db8:{digest[:4]}:{digest[4:8]}::1"


def _ip6(test_ns: str, host: int = 1) -> str:
    digest = hashlib.sha256(test_ns.encode()).hexdigest()
    return f"2001:db8:{digest[:4]}:{digest[4:8]}::{host}"


def _ip_bucket_value(ip: str) -> str:
    address = ipaddress.ip_address(ip)
    return str(ipaddress.ip_network(f"{address}/64", strict=False)) if address.version == 6 else str(address)


def _login(client, headers, email: str, ip: str):
    return client.post(
        LOGIN_URL,
        headers={**headers, "X-Forwarded-For": ip},
        json={"email": email, "password": "potato-pass-123"},
    )


def _signup(client, headers, email: str, ip: str):
    return client.post(
        SIGNUP_URL,
        headers={**headers, "X-Forwarded-For": ip},
        json={
            "email": email,
            "password": "potato-pass-123",
            "password_confirmation": "potato-pass-123",
        },
    )


def _assert_limited(response, window_seconds: int = 600):
    assert response.status_code == 429
    assert response.json()["error"] == {
        "code": "RATE_LIMITED",
        "message": MESSAGE,
        "fields": {},
    }
    assert response.headers["cache-control"] == "no-store"
    retry_after = int(response.headers["retry-after"])
    assert 1 <= retry_after <= window_seconds
    assert "set-cookie" not in response.headers


def _speed_up_password_checks(monkeypatch):
    import app.services.auth as auth_service

    calls = {"verify": 0, "dummy": 0}
    monkeypatch.setattr(auth_service, "verify_password", lambda *_: calls.__setitem__("verify", calls["verify"] + 1) or False)
    monkeypatch.setattr(auth_service, "verify_dummy_password", lambda *_: calls.__setitem__("dummy", calls["dummy"] + 1))
    return calls


def test_login_ip_limit_returns_429_with_retry_after(client, post_headers, rate_limited_settings, monkeypatch, test_ns):
    _speed_up_password_checks(monkeypatch)
    ip = _ip(test_ns)
    for index in range(3):
        response = _login(client, post_headers, ns_email(test_ns, f"ip-{index}"), ip)
        assert response.status_code == 401
    _assert_limited(_login(client, post_headers, ns_email(test_ns, "ip-over"), ip))


def test_login_email_limit_applies_across_ips(client, post_headers, rate_limited_settings, monkeypatch, test_ns):
    _speed_up_password_checks(monkeypatch)
    email = ns_email(test_ns, "same-email")
    for index in range(2):
        assert _login(client, post_headers, email, _ip(test_ns, index)).status_code == 401
    _assert_limited(_login(client, post_headers, email, _ip(test_ns, 3)))


def test_limited_login_never_runs_argon2(client, post_headers, rate_limited_settings, monkeypatch, test_ns):
    calls = _speed_up_password_checks(monkeypatch)
    ip = _ip(test_ns)
    for index in range(3):
        _login(client, post_headers, ns_email(test_ns, f"hash-{index}"), ip)
    before = calls.copy()
    _assert_limited(_login(client, post_headers, ns_email(test_ns, "hash-over"), ip))
    assert calls == before


def test_registered_and_unknown_email_limited_identically(client, post_headers, rate_limited_settings, monkeypatch, test_ns):
    _speed_up_password_checks(monkeypatch)
    registered = ns_email(test_ns, "registered")
    created = _signup(client, post_headers, registered, _ip(test_ns))
    assert created.status_code == 201

    results = []
    for label in ("registered", "unknown"):
        email = registered if label == "registered" else ns_email(test_ns, "unknown")
        for index in range(3):
            results.append(_login(client, post_headers, email, _ip(test_ns, index + (10 if label == "registered" else 20))))
    registered_limited, unknown_limited = results[2], results[5]
    _assert_limited(registered_limited)
    _assert_limited(unknown_limited)
    assert registered_limited.json() == unknown_limited.json()


def test_other_user_and_window_expiry_pass(client, post_headers, rate_limited_settings, monkeypatch, test_ns):
    _speed_up_password_checks(monkeypatch)
    import app.core.security as security

    ip = _ip(test_ns)
    email = ns_email(test_ns, "window")
    for index in range(3):
        assert _login(client, post_headers, ns_email(test_ns, f"window-{index}"), ip).status_code == 401
    _assert_limited(_login(client, post_headers, ns_email(test_ns, "window-over"), ip))
    assert _login(client, post_headers, ns_email(test_ns, "different-user"), _ip(test_ns, 4)).status_code == 401

    now = security.utcnow()
    monkeypatch.setattr(security, "utcnow", lambda: now + timedelta(seconds=601))
    assert _login(client, post_headers, email, ip).status_code == 401


def test_signup_ip_limit_and_mismatch_not_counted(client, post_headers, rate_limited_settings, monkeypatch, test_ns):
    _speed_up_password_checks(monkeypatch)
    ip = _ip(test_ns)
    mismatch = client.post(
        SIGNUP_URL,
        headers={**post_headers, "X-Forwarded-For": ip},
        json={"email": ns_email(test_ns, "mismatch"), "password": "potato-pass-123", "password_confirmation": "wrong-pass-123"},
    )
    assert mismatch.status_code == 422
    assert mismatch.json()["error"]["code"] == "PASSWORD_MISMATCH"
    for index in range(2):
        response = _signup(client, post_headers, ns_email(test_ns, f"signup-{index}"), ip)
        assert response.status_code == 201
        assert "gamja_session=" in response.headers["set-cookie"]
    _assert_limited(_signup(client, post_headers, ns_email(test_ns, "signup-over"), ip), window_seconds=3600)


def test_forwarded_for_ignored_without_trust(post_headers, rate_limited_settings, monkeypatch, test_ns):
    from app.main import app
    _speed_up_password_checks(monkeypatch)
    rate_limited_settings["settings"].trust_proxy_ip_headers = False
    with TestClient(app, raise_server_exceptions=False, client=(_ip(test_ns), 50000)) as isolated_client:
        for index in range(3):
            assert _login(isolated_client, post_headers, ns_email(test_ns, f"proxy-{index}"), _ip(test_ns, index + 10)).status_code == 401
        _assert_limited(_login(isolated_client, post_headers, ns_email(test_ns, "proxy-over"), _ip(test_ns, 20)))


def test_ipv6_same_slash64_shares_bucket(client, post_headers, rate_limited_settings, monkeypatch, test_ns):
    _speed_up_password_checks(monkeypatch)
    first = str(ipaddress.ip_address(_ip6(test_ns, 1)))
    second = str(ipaddress.ip_address(_ip6(test_ns, 2)))
    for index in range(3):
        assert _login(client, post_headers, ns_email(test_ns, f"v6-{index}"), first).status_code == 401
    _assert_limited(_login(client, post_headers, ns_email(test_ns, "v6-over"), second))


def test_rate_limit_store_failure_is_503_without_hashing(client, post_headers, rate_limited_settings, monkeypatch, test_ns):
    calls = _speed_up_password_checks(monkeypatch)
    from app.db.session import get_db
    from app.main import app

    class FailedRateLimitSession:
        def execute(self, *_args, **_kwargs):
            raise SQLAlchemyError("injected store failure")
        def rollback(self):
            pass
        def close(self):
            pass

    def failed_db():
        yield FailedRateLimitSession()
    app.dependency_overrides[get_db] = failed_db
    try:
        response = _login(client, post_headers, ns_email(test_ns, "db-failure"), _ip(test_ns))
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "SERVICE_UNAVAILABLE"
    assert calls == {"verify": 0, "dummy": 0}
    assert "database_url" not in response.text and "SELECT" not in response.text


def test_rate_limit_disabled_skips_store(client, post_headers, rate_limited_settings, monkeypatch, test_ns):
    from app.api import auth as auth_api
    from app.db.session import get_db
    from app.main import app
    from app.services.auth import InvalidCredentials

    rate_limited_settings["settings"].auth_rate_limit_enabled = False
    calls = []
    class NoStoreSession:
        def execute(self, *_args, **_kwargs):
            calls.append("store")
            raise AssertionError("disabled rate limiter touched the store")
        def close(self):
            pass
        def rollback(self):
            pass
    def fake_db():
        yield NoStoreSession()
    def fake_login(*_args, **_kwargs):
        raise InvalidCredentials
    monkeypatch.setattr(auth_api, "login", fake_login)
    app.dependency_overrides[get_db] = fake_db
    try:
        response = _login(client, post_headers, ns_email(test_ns, "disabled"), _ip(test_ns))
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert response.status_code == 401
    assert calls == []


def test_bucket_keys_are_hashed(client, post_headers, rate_limited_settings, monkeypatch, test_ns, db_engine):
    _speed_up_password_checks(monkeypatch)
    email = ns_email(test_ns, "hashed-bucket")
    ip = _ip(test_ns)
    _login(client, post_headers, email, ip)
    expected = {
        hashlib.sha256(f"login:ip:{_ip_bucket_value(ip)}".encode()).hexdigest(),
        hashlib.sha256(f"login:email:{email}".encode()).hexdigest(),
    }
    with db_engine.connect() as connection:
        keys = set(connection.scalars(text("SELECT bucket_key FROM app_private.auth_rate_limits WHERE bucket_key = ANY(:keys)"), {"keys": list(expected)}))
    assert keys == expected
    assert all(re.fullmatch(r"[0-9a-f]{64}", key) for key in keys)
    assert email not in keys and ip not in keys


def test_concurrent_consumption_is_atomic(post_headers, rate_limited_settings, monkeypatch, test_ns, db_engine):
    from app.main import app
    _speed_up_password_checks(monkeypatch)
    ip = _ip(test_ns)
    email = ns_email(test_ns, "concurrent")

    def one_request(index):
        with TestClient(app, raise_server_exceptions=False) as concurrent_client:
            return _login(concurrent_client, post_headers, email, ip)

    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(one_request, range(8)))
    assert sorted(response.status_code for response in responses) == [401, 401, 429, 429, 429, 429, 429, 429]
    keys = [
        hashlib.sha256(f"login:ip:{_ip_bucket_value(ip)}".encode()).hexdigest(),
        hashlib.sha256(f"login:email:{email}".encode()).hexdigest(),
    ]
    with db_engine.connect() as connection:
        counts = list(connection.scalars(text("SELECT hit_count FROM app_private.auth_rate_limits WHERE bucket_key = ANY(:keys)"), {"keys": keys}))
    assert counts == [8, 8]


def test_login_rate_limit_rolls_back_both_buckets_if_email_bucket_fails(
    client, post_headers, rate_limited_settings, test_ns
):
    """A failure while applying the second logical key must not persist the first."""
    from app.db.session import SessionLocal

    email = ns_email(test_ns, "second-bucket-failure")
    ip = _ip(test_ns)
    ip_key = hashlib.sha256(f"login:ip:{_ip_bucket_value(ip)}".encode()).hexdigest()
    email_key = hashlib.sha256(f"login:email:{email}".encode()).hexdigest()
    engine = SessionLocal.kw["bind"]
    injected = []

    def fail_email_bucket(_conn, _cursor, statement, parameters, _context, _executemany):
        if "auth_rate_limits" in statement and email_key in repr(parameters):
            injected.append(True)
            raise SQLAlchemyError("injected email bucket failure")

    event.listen(engine, "before_cursor_execute", fail_email_bucket)
    try:
        response = _login(client, post_headers, email, ip)
    finally:
        event.remove(engine, "before_cursor_execute", fail_email_bucket)

    assert injected == [True]
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "SERVICE_UNAVAILABLE"
    with engine.connect() as connection:
        persisted = connection.scalar(
            text("SELECT hit_count FROM app_private.auth_rate_limits WHERE bucket_key = :key"),
            {"key": ip_key},
        )
    assert persisted is None


def test_login_consumes_rate_limit_buckets_with_one_commit_and_bounded_connections(
    client, post_headers, rate_limited_settings, monkeypatch, test_ns
):
    from app.db.session import SessionLocal
    from sqlalchemy.orm import Session as OrmSession
    from tests.test_request_photos import signup
    import app.services.auth as auth_service

    email = ns_email(test_ns, "commit-count")
    ip = _ip(test_ns)
    monkeypatch.setattr(auth_service, "hash_password", lambda _password: "test-password-hash")
    monkeypatch.setattr(auth_service, "verify_password", lambda *_args: True)
    signup_response = client.post(
        SIGNUP_URL,
        headers={**post_headers, "X-Forwarded-For": ip},
        json={
            "email": email,
            "password": "potato-pass-123",
            "password_confirmation": "potato-pass-123",
        },
    )
    assert signup_response.status_code == 201, signup_response.text
    client.cookies.clear()

    commits = []
    connections = []
    engine = SessionLocal.kw["bind"]
    def after_commit(_session):
        commits.append(True)
    def on_connect(_dbapi_connection, _connection_record):
        connections.append(True)

    event.listen(OrmSession, "after_commit", after_commit)
    event.listen(engine, "connect", on_connect)
    try:
        response = _login(client, post_headers, email, ip)
    finally:
        event.remove(OrmSession, "after_commit", after_commit)
        event.remove(engine, "connect", on_connect)

    assert response.status_code == 200, response.text
    # The login session itself commits once, so two total commits means the
    # IP and email rate-limit buckets shared their single required commit.
    assert len(commits) == 2
    # NullPool opens a connection per transaction; rate limiting should need
    # one connection, plus the user lookup and successful session insert.
    assert len(connections) <= 3
