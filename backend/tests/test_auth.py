from __future__ import annotations

from sqlalchemy import create_engine, text

def signup_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "email": "  Buyer@Example.com  ",
        "password": "potato-pass-123",
        "password_confirmation": "potato-pass-123",
    }
    payload.update(overrides)
    return payload


def assert_error(response, status: int, code: str) -> None:
    assert response.status_code == status
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["error"]["code"] == code
    assert isinstance(response.json()["error"]["fields"], dict)


def test_signup_me_logout_and_relogin(client, post_headers) -> None:
    signup = client.post("/api/auth/signup", headers=post_headers, json=signup_payload())
    assert signup.status_code == 201
    assert signup.headers["cache-control"] == "no-store"
    assert signup.json()["user"]["email"] == "buyer@example.com"
    cookie = signup.headers["set-cookie"]
    assert "gamja_session=" in cookie
    assert "HttpOnly" in cookie and "SameSite=lax" in cookie and "Path=/" in cookie and "Max-Age=604800" in cookie

    current = client.get("/api/auth/me")
    assert current.status_code == 200
    assert current.json() == signup.json()

    logout = client.post("/api/auth/logout", headers=post_headers, json={})
    assert logout.status_code == 204
    assert logout.content == b""
    assert "Max-Age=0" in logout.headers["set-cookie"]
    unauthenticated = client.get("/api/auth/me")
    assert_error(unauthenticated, 401, "UNAUTHENTICATED")
    assert "Max-Age=0" in unauthenticated.headers["set-cookie"]

    relogin = client.post(
        "/api/auth/login", headers=post_headers,
        json={"email": "BUYER@example.com", "password": "potato-pass-123"},
    )
    assert relogin.status_code == 200
    assert relogin.json() == signup.json()


def test_signup_mismatch_precedes_database_work_and_never_returns_secret(client, post_headers) -> None:
    from app.core.config import get_settings

    response = client.post(
        "/api/auth/signup", headers=post_headers,
        json=signup_payload(password_confirmation="different-password-123"),
    )
    assert_error(response, 422, "PASSWORD_MISMATCH")
    assert response.json()["error"] == {
        "code": "PASSWORD_MISMATCH",
        "message": "비밀번호가 일치하지 않습니다.",
        "fields": {"password_confirmation": "비밀번호가 일치하지 않습니다."},
    }
    assert "potato-pass-123" not in response.text
    assert "different-password-123" not in response.text
    engine = create_engine(get_settings().database_url)
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM app_private.users")) == 0
    engine.dispose()


def test_validation_duplicate_login_and_post_security_contract(client, post_headers) -> None:
    invalid = client.post("/api/auth/signup", headers=post_headers, content='{"email":')
    assert_error(invalid, 422, "VALIDATION_ERROR")

    short_confirmation = client.post("/api/auth/signup", headers=post_headers, json=signup_payload(password_confirmation="short"))
    assert_error(short_confirmation, 422, "VALIDATION_ERROR")
    assert "password_confirmation" in short_confirmation.json()["error"]["fields"]

    assert client.post("/api/auth/signup", headers=post_headers, json=signup_payload()).status_code == 201
    duplicate = client.post("/api/auth/signup", headers=post_headers, json=signup_payload(email="buyer@example.com"))
    assert_error(duplicate, 409, "EMAIL_ALREADY_EXISTS")
    assert duplicate.json()["error"]["fields"] == {"email": "이미 가입된 이메일입니다."}

    bad_login = client.post("/api/auth/login", headers=post_headers, json={"email": "buyer@example.com", "password": "wrong-pass-123"})
    missing_login = client.post("/api/auth/login", headers=post_headers, json={"email": "nobody@example.com", "password": "wrong-pass-123"})
    assert_error(bad_login, 401, "INVALID_CREDENTIALS")
    assert bad_login.json() == missing_login.json()

    extra_login = client.post(
        "/api/auth/login", headers=post_headers,
        json={"email": "buyer@example.com", "password": "potato-pass-123", "password_confirmation": "potato-pass-123"},
    )
    assert_error(extra_login, 422, "VALIDATION_ERROR")

    invalid_origin = client.post("/api/auth/logout", headers={}, content='{"email":')
    assert_error(invalid_origin, 403, "INVALID_ORIGIN")
    invalid_content_type = client.post("/api/auth/logout", headers={k: v for k, v in post_headers.items() if k != "Content-Type"}, content="{}")
    assert_error(invalid_content_type, 415, "UNSUPPORTED_MEDIA_TYPE")
