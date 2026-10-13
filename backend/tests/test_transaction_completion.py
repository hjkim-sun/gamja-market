from __future__ import annotations

import uuid
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import text

from _application_support import apply, assert_error, complete, create_request, signup
from test_matching import confirm


def prepare_trade(client_factory, post_headers, test_ns, label="completion"):
    buyer = client_factory()
    seller = client_factory()
    signup(buyer, post_headers, test_ns, f"{label}-buyer")
    signup(seller, post_headers, test_ns, f"{label}-seller")
    request = create_request(buyer, post_headers, test_ns, label)
    application_response = apply(seller, post_headers, request["id"])
    assert application_response.status_code == 201, application_response.text
    application = application_response.json()["application"]
    matched = confirm(buyer, post_headers, request["id"], application["id"])
    assert matched.status_code == 200, matched.text
    return buyer, seller, request, application


def test_completion_is_buyer_only_and_idempotent(client_factory, post_headers, test_ns, db_engine):
    buyer, seller, request, application = prepare_trade(
        client_factory, post_headers, test_ns, "complete-auth-idempotency"
    )
    outsider = client_factory()
    signup(outsider, post_headers, test_ns, "complete-outsider")
    anonymous = client_factory()

    assert_error(complete(anonymous, post_headers, request["id"]), 401, "UNAUTHENTICATED")
    assert_error(complete(outsider, post_headers, request["id"]), 403, "COMPLETION_FORBIDDEN")
    assert_error(complete(seller, post_headers, request["id"]), 403, "COMPLETION_FORBIDDEN")

    first = complete(buyer, post_headers, request["id"])
    assert first.status_code == 200, first.text
    payload = first.json()
    assert payload["request"] == {
        "id": request["id"],
        "status": "completed",
        "completedAt": payload["request"]["completedAt"],
    }
    assert payload["acceptedApplicationId"] == application["id"]
    assert payload["chatRoomId"] == application["chatRoomId"]
    second = complete(buyer, post_headers, request["id"])
    assert second.status_code == 200, second.text
    assert second.json() == payload

    with db_engine.connect() as connection:
        row = connection.execute(
            text("SELECT status, completed_at, updated_at FROM app_private.purchase_requests WHERE id=:id"),
            {"id": request["id"]},
        ).mappings().one()
        app_row = connection.execute(
            text("SELECT status, decided_at FROM app_private.seller_applications WHERE id=:id"),
            {"id": application["id"]},
        ).mappings().one()
    assert row["status"] == "completed"
    assert row["completed_at"] == row["updated_at"]
    assert datetime.fromisoformat(payload["request"]["completedAt"].replace("Z", "+00:00")) == row["completed_at"]
    assert app_row["status"] == "accepted"
    assert app_row["decided_at"] is not None



def test_completion_requires_matched_state_and_valid_post_request(client_factory, post_headers, test_ns, db_engine):
    buyer = client_factory()
    signup(buyer, post_headers, test_ns, "complete-requires-matched")
    open_request = create_request(buyer, post_headers, test_ns, "완료 전 요청")
    assert_error(complete(buyer, post_headers, open_request["id"]), 409, "REQUEST_NOT_MATCHED")

    closed_request = create_request(buyer, post_headers, test_ns, "마감 요청")
    with db_engine.begin() as connection:
        connection.execute(
            text("UPDATE app_private.purchase_requests SET status='closed' WHERE id=:id"),
            {"id": closed_request["id"]},
        )
    assert_error(complete(buyer, post_headers, closed_request["id"]), 409, "REQUEST_NOT_MATCHED")

    unmatched_request = create_request(buyer, post_headers, test_ns, "확정 지원이 없는 matched 요청")
    with db_engine.begin() as connection:
        connection.execute(
            text("UPDATE app_private.purchase_requests SET status='matched' WHERE id=:id"),
            {"id": unmatched_request["id"]},
        )
    assert_error(complete(buyer, post_headers, unmatched_request["id"]), 409, "REQUEST_NOT_MATCHED")

    no_origin = {key: value for key, value in post_headers.items() if key != "Origin"}
    assert_error(complete(buyer, no_origin, open_request["id"]), 403, "INVALID_ORIGIN")
    assert_error(complete(buyer, post_headers, "not-a-uuid"), 422, "VALIDATION_ERROR")
    missing = complete(buyer, post_headers, str(uuid.uuid4()))
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "NOT_FOUND"

def test_completed_room_is_read_only_but_history_remains(client_factory, post_headers, test_ns):
    buyer, seller, request, application = prepare_trade(
        client_factory, post_headers, test_ns, "completion-readonly"
    )
    initial = seller.post(
        f"/api/chat-rooms/{application['chatRoomId']}/messages",
        headers=post_headers,
        json={"clientMessageId": str(uuid.uuid4()), "body": "이전 대화"},
    )
    assert initial.status_code == 201, initial.text
    assert complete(buyer, post_headers, request["id"]).status_code == 200

    room = buyer.get(f"/api/chat-rooms/{application['chatRoomId']}")
    assert room.status_code == 200, room.text
    assert room.json()["chatStatus"] == "completed"
    assert room.json()["canSend"] is False
    assert room.json()["request"]["status"] == "completed"
    history = buyer.get(f"/api/chat-rooms/{application['chatRoomId']}/messages")
    assert history.status_code == 200, history.text
    assert any(item["body"] == "이전 대화" for item in history.json()["items"])
    for participant in (buyer, seller):
        response = participant.post(
            f"/api/chat-rooms/{application['chatRoomId']}/messages",
            headers=post_headers,
            json={"clientMessageId": str(uuid.uuid4()), "body": "늦은 메시지"},
        )
        assert_error(response, 409, "CHAT_ROOM_CLOSED")


def test_completed_request_appears_in_existing_read_endpoints(client_factory, post_headers, test_ns):
    buyer, _, request, application = prepare_trade(
        client_factory, post_headers, test_ns, "completion-existing-reads"
    )
    assert complete(buyer, post_headers, request["id"]).status_code == 200

    detail = buyer.get(f"/api/requests/{request['id']}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["status"] == "completed"
    rooms = buyer.get("/api/chat-rooms")
    assert rooms.status_code == 200, rooms.text
    room_list_item = next(item for item in rooms.json()["items"] if item["id"] == application["chatRoomId"])
    assert room_list_item["chatStatus"] == "completed"
    assert room_list_item["request"]["status"] == "completed"


def test_concurrent_completion_returns_one_stable_result(client_factory, post_headers, test_ns):
    buyer, _, request, _ = prepare_trade(client_factory, post_headers, test_ns, "completion-race")
    clients = [buyer] + [client_factory() for _ in range(5)]
    # Reuse the buyer's authenticated session without creating distinct identities.
    cookie = buyer.cookies.get("gamja_session")
    for client in clients[1:]:
        client.cookies.set("gamja_session", cookie)
    with ThreadPoolExecutor(max_workers=len(clients)) as executor:
        responses = list(executor.map(lambda client: complete(client, post_headers, request["id"]), clients))

    assert [response.status_code for response in responses] == [200] * len(clients)
    assert len({response.json()["request"]["completedAt"] for response in responses}) == 1
