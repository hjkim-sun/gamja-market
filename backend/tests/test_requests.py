from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError


REQUEST_PATH = "/api/requests"
EXPECTED_CHECKS = {
    "ck_purchase_requests_price_range",
    "ck_purchase_requests_price_max_bound",
    "ck_purchase_requests_status",
    "ck_purchase_requests_condition",
    "ck_purchase_requests_title_len",
    "ck_purchase_requests_description_len",
    "ck_purchase_requests_updated_after_created",
}
EXPECTED_INDEXES = {
    "ix_purchase_requests_created_at_id",
    "ix_purchase_requests_buyer_id",
    "ix_purchase_requests_category",
    "ix_purchase_requests_status",
}


def signup_payload(email: str = "buyer@example.com") -> dict[str, str]:
    return {
        "email": email,
        "password": "potato-pass-123",
        "password_confirmation": "potato-pass-123",
    }


def request_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "title": "아이패드 프로를 구합니다",
        "category": "디지털기기",
        "description": "M2 모델이며 상태가 깨끗한 제품을 찾고 있습니다.",
        "priceMin": 600_000,
        "priceMax": 800_000,
        "condition": "like_new",
        "region": "서울 강남구",
    }
    payload.update(overrides)
    return payload


def assert_error(response, status: int, code: str, field: str | None = None) -> None:
    assert response.status_code == status
    assert response.headers["cache-control"] == "no-store"
    body = response.json()["error"]
    assert body["code"] == code
    assert isinstance(body["fields"], dict)
    if field is not None:
        assert field in body["fields"]


def signup(client: TestClient, post_headers: dict[str, str], email: str = "buyer@example.com"):
    response = client.post("/api/auth/signup", headers=post_headers, json=signup_payload(email))
    assert response.status_code == 201
    return response


def create_request(
    client: TestClient,
    post_headers: dict[str, str],
    **overrides: object,
) -> dict[str, Any]:
    response = client.post(REQUEST_PATH, headers=post_headers, json=request_payload(**overrides))
    assert response.status_code == 201, response.text
    return response.json()


def database_engine():
    from app.core.config import get_settings

    return create_engine(get_settings().database_url)


def test_create_request_persists_and_returns_detail(client, post_headers) -> None:
    signup(client, post_headers)

    response = client.post(REQUEST_PATH, headers=post_headers, json=request_payload())

    assert response.status_code == 201
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert {"description", "buyer", "updatedAt"} <= body.keys()
    assert body["title"] == "아이패드 프로를 구합니다"
    assert body["description"] == request_payload()["description"]
    assert body["status"] == "open"
    assert body["applicantCount"] == 0
    assert body["thumbnailUrl"] is None
    assert body["isOwner"] is True
    assert body["buyer"]["maskedEmail"] == "bu***@example.com"
    uuid.UUID(body["id"])

    engine = database_engine()
    with engine.connect() as connection:
        row = connection.execute(
            text(
                "SELECT title, buyer_id, status, thumbnail_url "
                "FROM app_private.purchase_requests WHERE id = :id"
            ),
            {"id": body["id"]},
        ).mappings().one()
        assert row["title"] == body["title"]
        assert row["status"] == "open"
        assert row["thumbnail_url"] is None
        assert str(row["buyer_id"]) == body["buyer"]["id"]
    engine.dispose()


def test_create_request_requires_authentication(client, post_headers) -> None:
    response = client.post(REQUEST_PATH, headers=post_headers, json=request_payload())
    assert_error(response, 401, "UNAUTHENTICATED")

    engine = database_engine()
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM app_private.purchase_requests")) == 0
    engine.dispose()


def test_create_request_rejects_missing_origin_header(client, post_headers) -> None:
    signup(client, post_headers)
    without_origin = {key: value for key, value in post_headers.items() if key != "Origin"}
    without_requested_with = {
        key: value for key, value in post_headers.items() if key != "X-Requested-With"
    }

    assert_error(
        client.post(REQUEST_PATH, headers=without_origin, json=request_payload()),
        403,
        "INVALID_ORIGIN",
    )
    assert_error(
        client.post(REQUEST_PATH, headers=without_requested_with, json=request_payload()),
        403,
        "INVALID_ORIGIN",
    )


def test_create_request_rejects_non_json_content_type(client, post_headers) -> None:
    signup(client, post_headers)
    headers = {**post_headers, "Content-Type": "text/plain"}
    response = client.post(REQUEST_PATH, headers=headers, content=json.dumps(request_payload()))
    assert_error(response, 415, "UNSUPPORTED_MEDIA_TYPE")


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("title", "한"),
        ("title", "가" * 61),
        ("description", "가" * 9),
        ("description", "가" * 1001),
        ("region", "가" * 51),
        ("category", "식품"),
        ("condition", "broken"),
    ],
)
def test_create_request_validation_boundaries(client, post_headers, field, value) -> None:
    signup(client, post_headers)
    response = client.post(
        REQUEST_PATH,
        headers=post_headers,
        json=request_payload(**{field: value}),
    )
    assert_error(response, 422, "VALIDATION_ERROR", field)


def test_create_request_rejects_price_range_inversion(client, post_headers) -> None:
    signup(client, post_headers)
    response = client.post(
        REQUEST_PATH,
        headers=post_headers,
        json=request_payload(priceMin=900_000, priceMax=800_000),
    )
    assert_error(response, 422, "VALIDATION_ERROR", "priceMax")


@pytest.mark.parametrize(
    "overrides",
    [
        {"priceMin": -1},
        {"priceMax": 1_000_000_001},
        {"priceMin": 1.5},
        {"priceMax": "800000"},
    ],
)
def test_create_request_rejects_invalid_price_values(client, post_headers, overrides) -> None:
    signup(client, post_headers)
    response = client.post(REQUEST_PATH, headers=post_headers, json=request_payload(**overrides))
    expected_field = next(iter(overrides))
    assert_error(response, 422, "VALIDATION_ERROR", expected_field)


@pytest.mark.parametrize(
    "field",
    ["status", "buyerId", "thumbnailUrl", "applicantCount", "id", "createdAt", "updatedAt"],
)
def test_create_request_rejects_server_controlled_fields(client, post_headers, field) -> None:
    signup(client, post_headers)
    response = client.post(
        REQUEST_PATH,
        headers=post_headers,
        json=request_payload(**{field: "client-controlled"}),
    )
    assert_error(response, 422, "VALIDATION_ERROR")


@pytest.mark.parametrize(
    "field",
    ["title", "category", "description", "priceMin", "priceMax", "condition", "region"],
)
def test_create_request_requires_every_input_field(client, post_headers, field) -> None:
    signup(client, post_headers)
    payload = request_payload()
    payload.pop(field)
    response = client.post(REQUEST_PATH, headers=post_headers, json=payload)
    assert_error(response, 422, "VALIDATION_ERROR", field)


def test_create_request_trims_strings(client, post_headers) -> None:
    signup(client, post_headers)
    response = client.post(
        REQUEST_PATH,
        headers=post_headers,
        json=request_payload(
            title="  아이패드 프로  ",
            description="  충분히 자세한 제품 설명입니다.  ",
            region="  서울 마포구  ",
        ),
    )
    assert response.status_code == 201
    assert response.json()["title"] == "아이패드 프로"
    assert response.json()["description"] == "충분히 자세한 제품 설명입니다."
    assert response.json()["region"] == "서울 마포구"

    engine = database_engine()
    with engine.connect() as connection:
        stored = connection.execute(
            text(
                "SELECT title, description, region FROM app_private.purchase_requests "
                "WHERE id = :id"
            ),
            {"id": response.json()["id"]},
        ).mappings().one()
        assert dict(stored) == {
            "title": "아이패드 프로",
            "description": "충분히 자세한 제품 설명입니다.",
            "region": "서울 마포구",
        }
    engine.dispose()


def test_list_requests_is_public_and_paginated(client, post_headers) -> None:
    signup(client, post_headers)
    created_ids = {
        create_request(client, post_headers, title=f"구매요청 {index:02d}")["id"]
        for index in range(15)
    }
    client.cookies.clear()

    first = client.get(REQUEST_PATH)
    second = client.get(REQUEST_PATH, params={"page": 2})

    assert first.status_code == 200
    assert first.json()["total"] == 15
    assert first.json()["page"] == 1
    assert first.json()["pageSize"] == 12
    assert len(first.json()["items"]) == 12
    assert len(second.json()["items"]) == 3
    returned_ids = {item["id"] for item in first.json()["items"] + second.json()["items"]}
    assert returned_ids == created_ids
    assert all(item["isOwner"] is False for item in first.json()["items"])
    assert all("description" not in item and "buyer" not in item for item in first.json()["items"])


def test_list_requests_filters_by_category_status_and_query(client, post_headers) -> None:
    signup(client, post_headers)
    create_request(client, post_headers, title="iPad Pro를 구합니다", category="디지털기기")
    create_request(client, post_headers, title="IPAD mini를 찾습니다", category="디지털기기")
    create_request(client, post_headers, title="로봇 청소기를 구합니다", category="가전")
    client.cookies.clear()

    category = client.get(REQUEST_PATH, params={"category": "가전"}).json()
    query = client.get(REQUEST_PATH, params={"q": "ipad"}).json()
    combined = client.get(
        REQUEST_PATH,
        params={"category": "디지털기기", "status": "open", "q": "mini"},
    ).json()

    assert [item["title"] for item in category["items"]] == ["로봇 청소기를 구합니다"]
    assert {item["title"] for item in query["items"]} == {
        "iPad Pro를 구합니다",
        "IPAD mini를 찾습니다",
    }
    assert [item["title"] for item in combined["items"]] == ["IPAD mini를 찾습니다"]
    assert combined["total"] == 1


def test_list_query_escapes_like_wildcards(client, post_headers) -> None:
    signup(client, post_headers)
    create_request(client, post_headers, title="100% 확실한 거래")
    create_request(client, post_headers, title="under_score 모델")
    create_request(client, post_headers, title="평범한 제목입니다")
    client.cookies.clear()

    percent = client.get(REQUEST_PATH, params={"q": "%"}).json()
    underscore = client.get(REQUEST_PATH, params={"q": "_"}).json()

    assert [item["title"] for item in percent["items"]] == ["100% 확실한 거래"]
    assert [item["title"] for item in underscore["items"]] == ["under_score 모델"]


def test_list_requests_sorting(client, post_headers) -> None:
    signup(client, post_headers)
    low = create_request(
        client, post_headers, title="낮은 가격 요청", priceMin=100_000, priceMax=200_000
    )
    high = create_request(
        client, post_headers, title="높은 가격 요청", priceMin=700_000, priceMax=900_000
    )
    middle = create_request(
        client, post_headers, title="중간 가격 요청", priceMin=300_000, priceMax=500_000
    )

    engine = database_engine()
    with engine.begin() as connection:
        for request_id, created_at in [
            (low["id"], "2026-09-19T00:00:00+00:00"),
            (high["id"], "2026-09-20T00:00:00+00:00"),
            (middle["id"], "2026-09-21T00:00:00+00:00"),
        ]:
            connection.execute(
                text(
                    "UPDATE app_private.purchase_requests "
                    "SET created_at=:created_at, updated_at=:created_at WHERE id=:id"
                ),
                {"created_at": created_at, "id": request_id},
            )
    engine.dispose()
    client.cookies.clear()

    latest = client.get(REQUEST_PATH, params={"sort": "latest"})
    price = client.get(REQUEST_PATH, params={"sort": "price"})
    applicants = client.get(REQUEST_PATH, params={"sort": "applicants"})

    assert [item["id"] for item in latest.json()["items"]] == [middle["id"], high["id"], low["id"]]
    assert [item["id"] for item in price.json()["items"]] == [high["id"], middle["id"], low["id"]]
    assert applicants.status_code == 200
    assert [item["id"] for item in applicants.json()["items"]] == [middle["id"], high["id"], low["id"]]


def test_list_requests_pagination_is_stable(client, post_headers) -> None:
    signup(client, post_headers)
    created = [create_request(client, post_headers, title=f"동시 요청 {index}") for index in range(5)]
    engine = database_engine()
    with engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE app_private.purchase_requests "
                "SET created_at=:created_at, updated_at=:created_at"
            ),
            {"created_at": datetime(2026, 9, 21, tzinfo=timezone.utc)},
        )
    engine.dispose()
    client.cookies.clear()

    pages = [
        client.get(REQUEST_PATH, params={"page": page, "pageSize": 2}).json()["items"]
        for page in (1, 2, 3)
    ]
    returned = [item["id"] for page in pages for item in page]

    assert len(returned) == len(set(returned)) == 5
    assert set(returned) == {item["id"] for item in created}


@pytest.mark.parametrize(
    "params",
    [{"page": 0}, {"pageSize": 0}, {"pageSize": 51}, {"page": "abc"}],
)
def test_list_requests_rejects_invalid_pagination(client, params) -> None:
    assert_error(client.get(REQUEST_PATH, params=params), 422, "VALIDATION_ERROR")


@pytest.mark.parametrize(
    "params",
    [{"category": "식품"}, {"q": "가" * 61}, {"q": "   "}],
)
def test_list_requests_rejects_invalid_filter_values(client, params) -> None:
    assert_error(client.get(REQUEST_PATH, params=params), 422, "VALIDATION_ERROR")


def test_list_requests_falls_back_on_unknown_sort_and_status(client, post_headers) -> None:
    signup(client, post_headers)
    create_request(client, post_headers, title="첫 번째 요청")
    create_request(client, post_headers, title="두 번째 요청")
    client.cookies.clear()

    latest = client.get(REQUEST_PATH).json()
    unknown_sort = client.get(REQUEST_PATH, params={"sort": "bogus"})
    unknown_status = client.get(REQUEST_PATH, params={"status": "bogus"})

    assert unknown_sort.status_code == 200
    assert unknown_status.status_code == 200
    assert unknown_sort.json() == latest
    assert unknown_status.json()["total"] == 2


def test_public_reads_ignore_an_invalid_session_cookie(client) -> None:
    client.cookies.set("gamja_session", "x" * 43)

    listed = client.get(REQUEST_PATH)
    missing = client.get(f"{REQUEST_PATH}/{uuid.uuid4()}")

    assert listed.status_code == 200
    assert listed.json()["items"] == []
    assert_error(missing, 404, "NOT_FOUND")


def test_list_and_detail_expose_is_owner_by_session(client, post_headers) -> None:
    signup(client, post_headers, "owner@example.com")
    created = create_request(client, post_headers)

    owner_list = client.get(REQUEST_PATH).json()
    owner_detail = client.get(f"{REQUEST_PATH}/{created['id']}").json()
    assert owner_list["items"][0]["isOwner"] is True
    assert owner_detail["isOwner"] is True

    client.cookies.clear()
    signup(client, post_headers, "other@example.com")
    assert client.get(REQUEST_PATH).json()["items"][0]["isOwner"] is False
    assert client.get(f"{REQUEST_PATH}/{created['id']}").json()["isOwner"] is False

    client.cookies.clear()
    assert client.get(REQUEST_PATH).json()["items"][0]["isOwner"] is False
    assert client.get(f"{REQUEST_PATH}/{created['id']}").json()["isOwner"] is False


@pytest.mark.parametrize(
    ("email", "masked"),
    [("buyer@example.com", "bu***@example.com"), ("a@example.com", "a*@example.com")],
)
def test_detail_returns_masked_buyer_email_only(client, post_headers, email, masked) -> None:
    signup(client, post_headers, email)
    created = create_request(client, post_headers)
    client.cookies.clear()

    response = client.get(f"{REQUEST_PATH}/{created['id']}")

    assert response.status_code == 200
    assert response.json()["buyer"]["maskedEmail"] == masked
    assert email not in response.text
    assert set(response.json()["buyer"]) == {"id", "maskedEmail"}


def test_detail_returns_404_for_unknown_and_422_for_malformed_id(client) -> None:
    missing = client.get(f"{REQUEST_PATH}/{uuid.uuid4()}")
    malformed = client.get(f"{REQUEST_PATH}/not-a-uuid")

    assert_error(missing, 404, "NOT_FOUND")
    assert_error(malformed, 422, "VALIDATION_ERROR")


def test_detail_response_has_open_status_and_equal_timestamps(client, post_headers) -> None:
    signup(client, post_headers)
    created = create_request(client, post_headers)
    response = client.get(f"{REQUEST_PATH}/{created['id']}")

    assert response.status_code == 200
    assert response.json()["status"] == "open"
    assert response.json()["updatedAt"] == response.json()["createdAt"]


def test_patch_and_delete_are_not_implemented(client) -> None:
    request_id = uuid.uuid4()
    assert client.patch(f"{REQUEST_PATH}/{request_id}", json={"title": "수정"}).status_code == 405
    assert client.delete(f"{REQUEST_PATH}/{request_id}").status_code == 405


def test_request_endpoints_set_no_store(client, post_headers) -> None:
    signup(client, post_headers)
    created = client.post(REQUEST_PATH, headers=post_headers, json=request_payload())
    listed = client.get(REQUEST_PATH)
    detailed = client.get(f"{REQUEST_PATH}/{created.json()['id']}")

    assert created.status_code == 201
    assert listed.status_code == 200
    assert detailed.status_code == 200
    assert created.headers["cache-control"] == "no-store"
    assert listed.headers["cache-control"] == "no-store"
    assert detailed.headers["cache-control"] == "no-store"


def test_deleting_user_cascades_requests(client, post_headers) -> None:
    signup(client, post_headers)
    created = create_request(client, post_headers)
    buyer_id = created["buyer"]["id"]

    engine = database_engine()
    with engine.begin() as connection:
        connection.execute(
            text("DELETE FROM app_private.users WHERE id = :buyer_id"),
            {"buyer_id": buyer_id},
        )
        assert connection.scalar(
            text("SELECT count(*) FROM app_private.purchase_requests WHERE id = :id"),
            {"id": created["id"]},
        ) == 0
    engine.dispose()


@pytest.mark.parametrize(
    "overrides",
    [
        {"price_min": 900_000, "price_max": 800_000},
        {"status": "bogus"},
        {"condition": "bogus"},
    ],
)
def test_db_check_constraints_reject_invalid_rows(client, post_headers, overrides) -> None:
    signup_response = signup(client, post_headers)
    buyer_id = signup_response.json()["user"]["id"]
    values: dict[str, object] = {
        "id": uuid.uuid4(),
        "buyer_id": buyer_id,
        "title": "유효한 제목",
        "description": "충분히 긴 유효한 제품 설명입니다.",
        "category": "디지털기기",
        "condition": "any",
        "price_min": 100_000,
        "price_max": 200_000,
        "region": "서울",
        "status": "open",
    }
    values.update(overrides)

    engine = database_engine()
    with pytest.raises(IntegrityError), engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO app_private.purchase_requests "
                "(id, buyer_id, title, description, category, condition, price_min, price_max, region, status) "
                "VALUES (:id, :buyer_id, :title, :description, :category, :condition, :price_min, :price_max, :region, :status)"
            ),
            values,
        )
    engine.dispose()


class FailingSession:
    def rollback(self) -> None:
        return None

    def close(self) -> None:
        return None

    def __getattr__(self, _: str):
        def fail(*args: object, **kwargs: object) -> None:
            raise SQLAlchemyError("postgresql://secret_user:secret-password@database/private")

        return fail


def test_database_failure_returns_503_without_leaking_credentials(client, caplog) -> None:
    from app.db.session import get_db
    from app.main import app

    def failing_db() -> Iterator[FailingSession]:
        yield FailingSession()

    app.dependency_overrides[get_db] = failing_db
    caplog.set_level(logging.ERROR)
    try:
        response = client.get(REQUEST_PATH)
    finally:
        app.dependency_overrides.pop(get_db, None)

    assert_error(response, 503, "SERVICE_UNAVAILABLE")
    assert caplog.records
    combined = response.text + caplog.text
    assert "secret_user" not in combined
    assert "secret-password" not in combined
    assert "database/private" not in combined


def test_migration_0002_upgrade_and_downgrade() -> None:
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    engine = database_engine()

    command.upgrade(config, "head")
    db_inspector = inspect(engine)
    assert db_inspector.has_table("purchase_requests", schema="app_private")
    assert EXPECTED_CHECKS <= {
        constraint["name"]
        for constraint in db_inspector.get_check_constraints(
            "purchase_requests", schema="app_private"
        )
    }
    assert EXPECTED_INDEXES <= {
        index["name"]
        for index in db_inspector.get_indexes("purchase_requests", schema="app_private")
    }

    try:
        command.downgrade(config, "0001_create_auth_tables")
        downgraded = inspect(engine)
        assert not downgraded.has_table("purchase_requests", schema="app_private")
        assert downgraded.has_table("users", schema="app_private")
        assert downgraded.has_table("auth_sessions", schema="app_private")
    finally:
        command.upgrade(config, "head")
        engine.dispose()
