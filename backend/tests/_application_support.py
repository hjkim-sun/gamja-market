from __future__ import annotations

import json
import threading
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from conftest import ns_email, ns_title


APPLICATION_MESSAGE = "상태가 좋은 제품이며 구성품도 모두 보유하고 있습니다."


def signup(
    client: TestClient,
    post_headers: dict[str, str],
    test_ns: str,
    label: str,
) -> dict[str, Any]:
    response = client.post(
        "/api/auth/signup",
        headers=post_headers,
        json={
            "email": ns_email(test_ns, label),
            "password": "potato-pass-123",
            "password_confirmation": "potato-pass-123",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["user"]


def create_request(
    client: TestClient,
    post_headers: dict[str, str],
    test_ns: str,
    label: str = "동시 지원 검증 요청",
) -> dict[str, Any]:
    response = client.post(
        "/api/requests",
        headers=post_headers,
        json={
            "title": ns_title(test_ns, label),
            "category": "디지털기기",
            "description": "여러 판매자의 지원을 검증하기 위한 구매요청입니다.",
            "priceMin": 600_000,
            "priceMax": 800_000,
            "condition": "like_new",
            "region": "서울 강남구",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def apply_payload(index: int = 0) -> dict[str, Any]:
    return {
        "offerPrice": 700_000 + index,
        "message": f"{APPLICATION_MESSAGE} ({index})",
    }


def apply(
    client: TestClient,
    post_headers: dict[str, str],
    request_id: str,
    index: int = 0,
):
    return client.post(
        f"/api/requests/{request_id}/applications",
        headers=post_headers,
        json=apply_payload(index),
    )


def assert_error(response, status: int, code: str) -> None:
    assert response.status_code == status, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["error"]["code"] == code
    assert isinstance(response.json()["error"]["fields"], dict)


def fire_concurrently(calls: Iterable[Callable[[], Any]]) -> list[Any]:
    call_list = list(calls)
    barrier = threading.Barrier(len(call_list))

    def invoke(call: Callable[[], Any]):
        barrier.wait(timeout=5)
        return call()

    with ThreadPoolExecutor(max_workers=len(call_list)) as executor:
        futures = [executor.submit(invoke, call) for call in call_list]
        return [future.result(timeout=15) for future in futures]


def owned_counts(engine: Engine, request_id: str) -> tuple[int, int]:
    with engine.connect() as connection:
        row = connection.execute(
            text(
                "SELECT count(DISTINCT a.id) AS applications, count(r.id) AS rooms "
                "FROM app_private.seller_applications a "
                "LEFT JOIN app_private.chat_rooms r ON r.application_id = a.id "
                "WHERE a.request_id = :request_id"
            ),
            {"request_id": request_id},
        ).mappings().one()
    return int(row["applications"]), int(row["rooms"])


def assert_owned_invariants(engine: Engine, request_ids: list[str]) -> None:
    assert request_ids
    with engine.connect() as connection:
        violations = connection.execute(
            text(
                "SELECT "
                "count(*) FILTER (WHERE room_count <> 1) AS room_mismatches, "
                "count(*) FILTER (WHERE seller_id = buyer_id) AS self_applications, "
                "count(*) FILTER (WHERE buyer_id <> request_buyer_id) AS buyer_mismatches "
                "FROM ("
                " SELECT a.id, a.seller_id, a.buyer_id, p.buyer_id AS request_buyer_id, "
                "        count(r.id) AS room_count "
                " FROM app_private.seller_applications a "
                " JOIN app_private.purchase_requests p ON p.id = a.request_id "
                " LEFT JOIN app_private.chat_rooms r ON r.application_id = a.id "
                " WHERE a.request_id = ANY(:request_ids) "
                " GROUP BY a.id, a.seller_id, a.buyer_id, p.buyer_id"
                ") owned"
            ),
            {"request_ids": request_ids},
        ).mappings().one()
    assert dict(violations) == {
        "room_mismatches": 0,
        "self_applications": 0,
        "buyer_mismatches": 0,
    }


def assert_original_emails_absent(response, *emails: str) -> None:
    serialized = json.dumps(response.json(), ensure_ascii=False)
    for email in emails:
        assert email not in serialized
