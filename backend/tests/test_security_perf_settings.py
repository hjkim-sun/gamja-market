"""Behavioral checks for security settings, pool modes, storage client reuse, and compose."""
from __future__ import annotations

import logging
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError
from sqlalchemy.pool import NullPool, QueuePool

from app.core.config import Settings
from app.db.session import create_session_factory


def _settings(**overrides):
    values = {
        "database_url": "postgresql+psycopg://test:test@127.0.0.1/test",
        "auth_allowed_origins": ["http://localhost:3000"],
        "session_cookie_secure": False,
    }
    values.update(overrides)
    return Settings(**values)


def test_session_ttl_upper_bound():
    with pytest.raises(ValidationError) as error:
        _settings(session_ttl_seconds=2_592_001)
    assert "2592001" not in str(error.value)
    assert _settings(session_ttl_seconds=2_592_000).session_ttl_seconds == 2_592_000
    assert _settings().session_ttl_seconds == 604_800


@pytest.mark.parametrize("field", ["auth_login_window_seconds", "auth_signup_window_seconds"])
def test_auth_rate_limit_window_maximum_is_one_day(field):
    assert getattr(_settings(**{field: 86_400}), field) == 86_400
    with pytest.raises(ValidationError):
        _settings(**{field: 86_401})
    assert getattr(_settings(), field) > 0


def test_production_without_trusted_proxy_headers_logs_warning_but_starts(
    monkeypatch, caplog
):
    from app.core.config import get_settings
    from app.main import app
    from fastapi.testclient import TestClient

    monkeypatch.setenv("ENV", "production")
    monkeypatch.setenv("TRUST_PROXY_IP_HEADERS", "false")
    get_settings.cache_clear()
    try:
        with caplog.at_level(logging.WARNING):
            settings = get_settings()
            with TestClient(app, raise_server_exceptions=False) as client:
                response = client.get("/api/auth/me")
        assert settings.trust_proxy_ip_headers is False
        assert response.status_code == 401
        assert any(
            "TRUST_PROXY_IP_HEADERS" in record.getMessage()
            for record in caplog.records
            if record.levelno >= logging.WARNING
        )
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()
        get_settings()


def test_session_factory_pool_modes(monkeypatch):
    import app.db.session as db_session

    null_factory = create_session_factory(settings=_settings())
    null_engine = null_factory.kw["bind"]
    assert isinstance(null_engine.pool, NullPool)

    queue_settings = _settings(database_pool_mode="queue")
    queue_factory = create_session_factory(settings=queue_settings)
    queue_engine = queue_factory.kw["bind"]
    pool = queue_engine.pool
    assert isinstance(pool, QueuePool)
    assert pool.size() == 2
    assert pool._max_overflow == 2
    assert pool._recycle == 300
    assert pool._timeout == 5
    assert pool._pre_ping is True

    original_create_engine = db_session.create_engine
    captured = []
    def capture_engine(*args, **kwargs):
        captured.append(kwargs.copy())
        return original_create_engine(*args, **kwargs)
    monkeypatch.setattr(db_session, "create_engine", capture_engine)
    prepared_settings = _settings(database_disable_prepared_statements=True)
    prepared_factory = create_session_factory(settings=prepared_settings)
    assert captured[-1]["connect_args"] == {"prepare_threshold": None}
    prepared_factory.kw["bind"].dispose()
    null_engine.dispose()
    queue_engine.dispose()


def test_supabase_client_is_reused(monkeypatch):
    import app.storage.supabase as supabase_module

    original_client = httpx.Client
    created = []
    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, content=b"photo-bytes")
        if request.method == "DELETE":
            return httpx.Response(200, json=[])
        return httpx.Response(200)
    default_transport = httpx.MockTransport(handler)
    def count_client(*args, **kwargs):
        created.append(kwargs.get("transport"))
        kwargs.setdefault("transport", default_transport)
        return original_client(*args, **kwargs)

    monkeypatch.setattr(supabase_module, "_shared_client", None)
    monkeypatch.setattr(supabase_module.httpx, "Client", count_client)
    storage_a = supabase_module.SupabasePhotoStorage("https://example.supabase.co", "secret", "photos")
    storage_b = supabase_module.SupabasePhotoStorage("https://example.supabase.co", "secret", "photos")
    storage_a.put("one.jpg", b"x", "image/jpeg")
    assert storage_a.read("one.jpg") == b"photo-bytes"
    assert storage_b.delete_many(["one.jpg"]) == {"one.jpg"}
    assert len(created) == 1

    injected_a = supabase_module.SupabasePhotoStorage(
        "https://example.supabase.co", "secret", "photos", transport=httpx.MockTransport(handler)
    )
    injected_b = supabase_module.SupabasePhotoStorage(
        "https://example.supabase.co", "secret", "photos", transport=httpx.MockTransport(handler)
    )
    assert injected_a.read("one.jpg") == b"photo-bytes"
    injected_b.put("two.jpg", b"x", "image/jpeg")
    assert len(created) == 3
    injected_a._injected_client.close()
    injected_b._injected_client.close()
    supabase_module._shared_client.close()


def test_dev_compose_binds_loopback_and_preserves_volume():
    root = Path(__file__).parents[2]
    compose = (root / "docker-compose.yml").read_text()
    assert "name: gamja-market" in compose
    assert "127.0.0.1:5432:5432" in compose
    assert "!test123" not in compose
    assert "postgres_data" in compose
    assert ".env" in (root / ".gitignore").read_text()
    assert "POSTGRES_PASSWORD=" in (root / ".env.example").read_text()
