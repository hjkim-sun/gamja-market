from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import text

from _application_support import apply, apply_payload, assert_error, create_request, signup
from conftest import ns_email


def make_applications(client_factory, post_headers, test_ns, count: int = 2, label: str = "match"):
    buyer = client_factory()
    signup(buyer, post_headers, test_ns, f"{label}-buyer")
    request = create_request(buyer, post_headers, test_ns, f"{label} 매칭 상태 전이")
    sellers = []
    applications = []
    for index in range(count):
        seller = client_factory()
        signup(seller, post_headers, test_ns, f"{label}-seller-{index}")
        response = apply(seller, post_headers, request["id"], index)
        assert response.status_code == 201, response.text
        sellers.append(seller)
        applications.append(response.json()["application"])
    return buyer, request, sellers, applications


def confirm(client, headers, request_id: str, application_id: str):
    return client.post(
        f"/api/requests/{request_id}/match",
        headers=headers,
        json={"applicationId": application_id},
    )


def test_confirm_match_accepts_one_and_closes_others(
    client_factory, post_headers, test_ns, db_engine
) -> None:
    buyer, request, sellers, applications = make_applications(
        client_factory, post_headers, test_ns, 3
    )
    response = confirm(buyer, post_headers, request["id"], applications[1]["id"])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["request"] == {"id": request["id"], "status": "matched"}
    assert body["acceptedApplicationId"] == applications[1]["id"]
    assert body["chatRoomId"] == applications[1]["chatRoomId"]
    assert body["closedApplicationCount"] == 2
    with db_engine.connect() as connection:
        states = connection.execute(
            text("SELECT id::text, status, decided_at FROM app_private.seller_applications WHERE request_id=:id"),
            {"id": request["id"]},
        ).mappings().all()
        req = connection.execute(
            text("SELECT status, updated_at FROM app_private.purchase_requests WHERE id=:id"),
            {"id": request["id"]},
        ).mappings().one()
    by_id = {row["id"]: row for row in states}
    assert by_id[applications[1]["id"]]["status"] == "accepted"
    assert all(by_id[item["id"]]["status"] == "closed" for i, item in enumerate(applications) if i != 1)
    assert all(row["decided_at"] is not None for row in states)
    assert len({row["decided_at"] for row in states}) == 1
    assert req["status"] == "matched"
    assert req["updated_at"] is not None
    assert sellers[1].get(f"/api/requests/{request['id']}/applications").json()["items"][0]["status"] == "accepted"


def test_confirm_match_is_idempotent_for_same_application(
    client_factory, post_headers, test_ns, db_engine
) -> None:
    buyer, request, _, applications = make_applications(client_factory, post_headers, test_ns)
    first = confirm(buyer, post_headers, request["id"], applications[0]["id"])
    assert first.status_code == 200, first.text
    with db_engine.connect() as connection:
        before = connection.scalar(text("SELECT decided_at FROM app_private.seller_applications WHERE id=:id"), {"id": applications[0]["id"]})
    second = confirm(buyer, post_headers, request["id"], applications[0]["id"])
    assert second.status_code == 200, second.text
    assert second.json() == first.json()
    with db_engine.connect() as connection:
        after = connection.scalar(text("SELECT decided_at FROM app_private.seller_applications WHERE id=:id"), {"id": applications[0]["id"]})
    assert after == before


def test_confirm_other_application_after_match_conflicts(
    client_factory, post_headers, test_ns, db_engine
) -> None:
    buyer, request, _, applications = make_applications(client_factory, post_headers, test_ns)
    assert confirm(buyer, post_headers, request["id"], applications[0]["id"]).status_code == 200
    response = confirm(buyer, post_headers, request["id"], applications[1]["id"])
    assert_error(response, 409, "REQUEST_ALREADY_MATCHED")
    with db_engine.connect() as connection:
        states = connection.execute(text("SELECT status FROM app_private.seller_applications WHERE request_id=:id"), {"id": request["id"]}).scalars().all()
    assert sorted(states) == ["accepted", "closed"]


def test_confirm_match_authorization(client_factory, post_headers, test_ns) -> None:
    buyer, request, sellers, applications = make_applications(client_factory, post_headers, test_ns)
    anonymous = client_factory()
    outsider = client_factory()
    signup(outsider, post_headers, test_ns, "match-outsider")
    assert_error(confirm(anonymous, post_headers, request["id"], applications[0]["id"]), 401, "UNAUTHENTICATED")
    assert_error(confirm(outsider, post_headers, request["id"], str(uuid.uuid4())), 403, "NOT_REQUEST_OWNER")
    assert_error(confirm(sellers[0], post_headers, request["id"], applications[0]["id"]), 403, "NOT_REQUEST_OWNER")
    other_buyer = client_factory()
    signup(other_buyer, post_headers, test_ns, "other-buyer")
    other_request = create_request(other_buyer, post_headers, test_ns, "다른 요청 지원 ID")
    other_seller = client_factory()
    signup(other_seller, post_headers, test_ns, "other-seller")
    other_application = apply(other_seller, post_headers, other_request["id"]).json()["application"]
    assert_error(confirm(buyer, post_headers, request["id"], other_application["id"]), 404, "NOT_FOUND")
    assert_error(confirm(buyer, post_headers, str(uuid.uuid4()), applications[0]["id"]), 404, "NOT_FOUND")


@pytest.mark.parametrize(
    "payload,field",
    [({}, "applicationId"), ({"applicationId": "bad"}, "applicationId"), ({"applicationId": str(uuid.uuid4()), "extra": True}, "applicationId")],
)
def test_confirm_match_validation(client_factory, post_headers, test_ns, payload, field) -> None:
    buyer, request, _, _ = make_applications(client_factory, post_headers, test_ns)
    response = buyer.post(f"/api/requests/{request['id']}/match", headers=post_headers, json=payload)
    assert_error(response, 422, "VALIDATION_ERROR")
    assert field in response.json()["error"]["fields"]


def test_confirm_match_origin_and_content_type(client_factory, post_headers, test_ns) -> None:
    buyer, request, _, applications = make_applications(client_factory, post_headers, test_ns)
    no_origin = {key: value for key, value in post_headers.items() if key != "Origin"}
    assert_error(confirm(buyer, no_origin, request["id"], applications[0]["id"]), 403, "INVALID_ORIGIN")
    plain = {**post_headers, "Content-Type": "text/plain"}
    response = buyer.post(f"/api/requests/{request['id']}/match", headers=plain, content=json.dumps({"applicationId": applications[0]["id"]}))
    assert_error(response, 415, "UNSUPPORTED_MEDIA_TYPE")


def test_confirm_match_on_closed_request(client_factory, post_headers, test_ns, db_engine) -> None:
    buyer, request, _, applications = make_applications(client_factory, post_headers, test_ns)
    with db_engine.begin() as connection:
        connection.execute(text("UPDATE app_private.purchase_requests SET status='closed' WHERE id=:id"), {"id": request["id"]})
    assert_error(confirm(buyer, post_headers, request["id"], applications[0]["id"]), 409, "REQUEST_CLOSED")
    assert buyer.get(f"/api/requests/{request['id']}/applications").json()["items"][0]["status"] == "pending"


def test_apply_after_match_rejected(client_factory, post_headers, test_ns) -> None:
    buyer, request, sellers, applications = make_applications(client_factory, post_headers, test_ns)
    assert confirm(buyer, post_headers, request["id"], applications[0]["id"]).status_code == 200
    assert_error(apply(sellers[1], post_headers, request["id"]), 409, "REQUEST_NOT_OPEN")


def test_application_list_exposes_status_by_role(client_factory, post_headers, test_ns) -> None:
    buyer, request, sellers, applications = make_applications(client_factory, post_headers, test_ns)
    assert confirm(buyer, post_headers, request["id"], applications[0]["id"]).status_code == 200
    owner_items = buyer.get(f"/api/requests/{request['id']}/applications").json()["items"]
    assert {item["id"]: item["status"] for item in owner_items} == {
        applications[0]["id"]: "accepted", applications[1]["id"]: "closed"
    }
    seller_items = sellers[1].get(f"/api/requests/{request['id']}/applications").json()["items"]
    assert [(item["id"], item["status"]) for item in seller_items] == [(applications[1]["id"], "closed")]
    outsider = client_factory()
    signup(outsider, post_headers, test_ns, "status-outsider")
    assert outsider.get(f"/api/requests/{request['id']}/applications").json()["items"] == []
