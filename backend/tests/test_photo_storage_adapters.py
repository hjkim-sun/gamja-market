from __future__ import annotations

import httpx
import json
import pytest
from pydantic import ValidationError

from app.core.config import Settings
from app.storage.supabase import SupabasePhotoStorage


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "database_url": "postgresql+psycopg://user:password@localhost/db",
        "auth_allowed_origins": ["http://localhost:3000"],
        "session_cookie_secure": False,
    }
    values.update(overrides)
    return Settings(**values)


def test_supabase_modern_secret_uses_apikey_without_bearer_and_delete_contract() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=[])

    storage = SupabasePhotoStorage("https://project.supabase.co", "sb_secret_not_for_logs", "request-photos", transport=httpx.MockTransport(handler))
    storage.put("photos/a.jpg", b"image", "image/jpeg")
    assert storage.delete_many(["photos/a.jpg"]) == {"photos/a.jpg"}
    assert requests[0].method == "POST"
    assert str(requests[0].url) == "https://project.supabase.co/storage/v1/object/request-photos/photos/a.jpg"
    assert requests[0].headers["apikey"] == "sb_secret_not_for_logs"
    assert "authorization" not in requests[0].headers
    assert requests[0].headers["x-upsert"] == "false"
    assert requests[0].headers["cache-control"] == "3600"
    assert requests[1].method == "DELETE"
    assert json.loads(requests[1].content) == {"prefixes": ["photos/a.jpg"]}


def test_supabase_legacy_jwt_bearer_and_malformed_delete_are_sanitized() -> None:
    captured: list[httpx.Request] = []

    def legacy_handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json=[])

    storage = SupabasePhotoStorage("https://project.supabase.co", "legacy.jwt.token", "photos", transport=httpx.MockTransport(legacy_handler))
    storage.put("photos/a.jpg", b"x", "image/jpeg")
    assert captured[0].headers["authorization"] == "Bearer legacy.jwt.token"

    bad = SupabasePhotoStorage("https://project.supabase.co", "sb_secret_hidden", "photos", transport=httpx.MockTransport(lambda _: httpx.Response(200, text="not-json")))
    with pytest.raises(Exception) as exc:
        bad.delete_many(["photos/a.jpg"])
    assert "sb_secret_hidden" not in str(exc.value)


def test_photo_settings_hide_secret_and_reject_unsafe_production_values() -> None:
    settings = _settings(photo_storage_driver="supabase", supabase_url="https://project.supabase.co", supabase_secret_key="sb_secret_never_show", supabase_storage_bucket="request-photos")
    assert "sb_secret_never_show" not in repr(settings)
    with pytest.raises(ValidationError):
        _settings(photo_storage_driver="local", photo_local_storage_dir="/tmp/photos", auth_allowed_origins=["https://market.example"])
    with pytest.raises(ValidationError):
        _settings(photo_storage_driver="supabase", supabase_url="https://user:pass@project.supabase.co/path", supabase_secret_key="secret", supabase_storage_bucket="photos")
