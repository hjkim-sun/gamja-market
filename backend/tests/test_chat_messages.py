from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from _application_support import apply, assert_error, create_request, signup


def make_room(client_factory, post_headers, test_ns, label: str = "messages"):
    buyer = client_factory()
    signup(buyer, post_headers, test_ns, f"{label}-buyer")
    request = create_request(buyer, post_headers, test_ns, f"{label} 채팅")
    seller = client_factory()
    signup(seller, post_headers, test_ns, f"{label}-seller")
    application = apply(seller, post_headers, request["id"])
    assert application.status_code == 201, application.text
    return buyer, seller, request, application.json()["application"], application.json()["chatRoom"]


def send(client, headers, room_id: str, client_message_id: str, body: str):
    return client.post(
        f"/api/chat-rooms/{room_id}/messages",
        headers=headers,
        json={"clientMessageId": client_message_id, "body": body},
    )


def test_send_and_poll_messages(client_factory, post_headers, test_ns) -> None:
    buyer, seller, _, _, room = make_room(client_factory, post_headers, test_ns)
    sent = []
    for client, body in [(seller, "판매자 첫 메시지"), (buyer, "구매자 응답"), (seller, "판매자 확인")]:
        response = send(client, post_headers, room["id"], str(uuid.uuid4()), body)
        assert response.status_code == 201, response.text
        sent.append(response.json()["message"])
    assert [item["seq"] for item in sent] == [1, 2, 3]
    assert [item["isMine"] for item in sent] == [True, True, True]
    assert [item["senderRole"] for item in sent] == ["seller", "buyer", "seller"]
    polled = buyer.get(f"/api/chat-rooms/{room['id']}/messages?afterSeq=1&limit=2")
    assert polled.status_code == 200, polled.text
    body = polled.json()
    assert [item["seq"] for item in body["items"]] == [2, 3]
    assert [item["isMine"] for item in body["items"]] == [True, False]
    assert [item["senderRole"] for item in body["items"]] == ["buyer", "seller"]
    assert body["latestSeq"] == 3
    assert body["hasMore"] is False


def test_send_is_idempotent_by_client_message_id(client_factory, post_headers, test_ns, db_engine) -> None:
    buyer, seller, _, _, room = make_room(client_factory, post_headers, test_ns, "idempotent")
    message_id = str(uuid.uuid4())
    first = send(seller, post_headers, room["id"], message_id, "한 번만 저장")
    retry = send(seller, post_headers, room["id"], message_id, "재시도 본문은 무시")
    assert first.status_code == 201, first.text
    assert retry.status_code == 200, retry.text
    assert retry.json() == first.json()
    other_sender = send(buyer, post_headers, room["id"], message_id, "같은 키, 다른 발신자")
    assert other_sender.status_code == 201, other_sender.text
    with db_engine.connect() as connection:
        rows = connection.execute(text("SELECT sender_id, client_message_id::text FROM app_private.chat_messages WHERE room_id=:id"), {"id": room["id"]}).all()
    assert len(rows) == 2
    assert len({row[0] for row in rows}) == 2


def test_message_access_matrix(client_factory, post_headers, test_ns) -> None:
    buyer, seller, _, _, room = make_room(client_factory, post_headers, test_ns, "access")
    other_buyer, other_seller, _, _, other_room = make_room(client_factory, post_headers, test_ns, "other-access")
    outsider = client_factory()
    signup(outsider, post_headers, test_ns, "access-outsider")
    anonymous = client_factory()
    assert buyer.get(f"/api/chat-rooms/{room['id']}/messages").status_code == 200
    assert seller.get(f"/api/chat-rooms/{room['id']}/messages").status_code == 200
    denied = outsider.get(f"/api/chat-rooms/{room['id']}/messages")
    missing = outsider.get(f"/api/chat-rooms/{uuid.uuid4()}/messages")
    assert_error(denied, 404, "NOT_FOUND")
    assert denied.json() == missing.json()
    assert_error(anonymous.get(f"/api/chat-rooms/{room['id']}/messages"), 401, "UNAUTHENTICATED")
    assert_error(send(outsider, post_headers, room["id"], str(uuid.uuid4()), "접근 불가"), 404, "NOT_FOUND")
    assert_error(send(other_seller, post_headers, room["id"], str(uuid.uuid4()), "다른 방 판매자"), 404, "NOT_FOUND")
    assert_error(send(anonymous, post_headers, room["id"], str(uuid.uuid4()), "익명"), 401, "UNAUTHENTICATED")


@pytest.mark.parametrize(
    "payload,field",
    [
        ({"clientMessageId": str(uuid.uuid4()), "body": " "}, "body"),
        ({"clientMessageId": str(uuid.uuid4()), "body": ""}, "body"),
        ({"clientMessageId": str(uuid.uuid4()), "body": "x" * 1001}, "body"),
        ({"clientMessageId": str(uuid.uuid4()), "body": 12}, "body"),
        ({"clientMessageId": "bad", "body": "x"}, "clientMessageId"),
        ({"clientMessageId": str(uuid.uuid4()), "body": "x", "seq": 4}, "body"),
    ],
)
def test_message_validation(client_factory, post_headers, test_ns, payload, field) -> None:
    _, seller, _, _, room = make_room(client_factory, post_headers, test_ns, "validation")
    response = seller.post(f"/api/chat-rooms/{room['id']}/messages", headers=post_headers, json=payload)
    assert_error(response, 422, "VALIDATION_ERROR")
    assert field in response.json()["error"]["fields"]


def test_message_trim_and_length_boundaries(client_factory, post_headers, test_ns) -> None:
    _, seller, _, _, room = make_room(client_factory, post_headers, test_ns, "boundaries")
    one = send(seller, post_headers, room["id"], str(uuid.uuid4()), " x ")
    thousand = send(seller, post_headers, room["id"], str(uuid.uuid4()), "가" * 1000)
    assert one.status_code == thousand.status_code == 201
    assert one.json()["message"]["body"] == "x"
    assert len(thousand.json()["message"]["body"]) == 1000
    assert_error(seller.get(f"/api/chat-rooms/{room['id']}/messages?afterSeq=-1"), 422, "VALIDATION_ERROR")
    assert_error(seller.get(f"/api/chat-rooms/{room['id']}/messages?limit=0"), 422, "VALIDATION_ERROR")
    assert_error(seller.get(f"/api/chat-rooms/{room['id']}/messages?limit=101"), 422, "VALIDATION_ERROR")


def test_closed_room_is_read_only(client_factory, post_headers, test_ns) -> None:
    buyer, seller, request, application, room = make_room(client_factory, post_headers, test_ns, "closed")
    accepted_seller = client_factory()
    signup(accepted_seller, post_headers, test_ns, "closed-selected-seller")
    accepted = apply(accepted_seller, post_headers, request["id"], 1)
    assert accepted.status_code == 201, accepted.text
    matched = buyer.post(f"/api/requests/{request['id']}/match", headers=post_headers, json={"applicationId": accepted.json()["application"]["id"]})
    assert matched.status_code == 200, matched.text
    for participant in (seller, buyer):
        assert_error(send(participant, post_headers, room["id"], str(uuid.uuid4()), "마감 뒤 전송"), 409, "CHAT_ROOM_CLOSED")
    read = seller.get(f"/api/chat-rooms/{room['id']}/messages")
    assert read.status_code == 200
    assert read.json()["room"]["chatStatus"] == "closed"
    assert read.json()["room"]["canSend"] is False
    accepted_room = accepted.json()["chatRoom"]["id"]
    assert send(accepted_seller, post_headers, accepted_room, str(uuid.uuid4()), "확정 방은 계속 대화 가능").status_code == 201


def test_legacy_non_open_pending_room_is_read_only(client_factory, post_headers, test_ns, db_engine) -> None:
    buyer, seller, request, _, room = make_room(client_factory, post_headers, test_ns, "legacy")
    with db_engine.begin() as connection:
        connection.execute(text("UPDATE app_private.purchase_requests SET status='matched' WHERE id=:id"), {"id": request["id"]})
    read = seller.get(f"/api/chat-rooms/{room['id']}/messages")
    assert read.status_code == 200
    assert read.json()["room"]["chatStatus"] == "closed"
    assert read.json()["room"]["canSend"] is False
    assert_error(send(seller, post_headers, room["id"], str(uuid.uuid4()), "legacy pending"), 409, "CHAT_ROOM_CLOSED")


def test_initial_load_returns_latest_window(client_factory, post_headers, test_ns) -> None:
    _, seller, _, _, room = make_room(client_factory, post_headers, test_ns, "window")
    for index in range(105):
        response = send(seller, post_headers, room["id"], str(uuid.uuid4()), f"message {index}")
        assert response.status_code == 201, response.text
    latest = seller.get(f"/api/chat-rooms/{room['id']}/messages")
    assert latest.status_code == 200, latest.text
    assert [item["seq"] for item in latest.json()["items"]] == list(range(6, 106))
    assert latest.json()["hasOlder"] is True
    partial = seller.get(f"/api/chat-rooms/{room['id']}/messages?afterSeq=0&limit=50")
    assert [item["seq"] for item in partial.json()["items"]] == list(range(1, 51))
    assert partial.json()["hasMore"] is True


def test_chat_room_list_scope_and_order(client_factory, post_headers, test_ns) -> None:
    buyer, seller, _, _, room = make_room(client_factory, post_headers, test_ns, "list-a")
    _, _, _, _, room_b = make_room(client_factory, post_headers, test_ns, "list-b")
    first = send(seller, post_headers, room["id"], str(uuid.uuid4()), "마지막 메시지 " + "x" * 120)
    assert first.status_code == 201
    listing = buyer.get("/api/chat-rooms")
    assert listing.status_code == 200, listing.text
    items = listing.json()["items"]
    assert {item["id"] for item in items} == {room["id"]}
    assert items[0]["lastMessage"]["body"] == ("마지막 메시지 " + "x" * 120)[:100]
    outsider = client_factory()
    signup(outsider, post_headers, test_ns, "list-outsider")
    assert outsider.get("/api/chat-rooms").json()["items"] == []
    assert room_b["id"] not in {item["id"] for item in items}


def test_chat_room_view_additive_fields(client_factory, post_headers, test_ns) -> None:
    buyer, seller, request, application, room = make_room(client_factory, post_headers, test_ns, "view")
    view = seller.get(f"/api/chat-rooms/{room['id']}")
    assert view.status_code == 200, view.text
    assert view.json()["applicationStatus"] == "pending"
    assert view.json()["chatStatus"] == "active"
    assert view.json()["canSend"] is True
    application_view = seller.get(f"/api/requests/{request['id']}/applications").json()["items"][0]
    assert application_view["status"] == "pending"


def test_message_routes_are_no_store(client_factory, post_headers, test_ns) -> None:
    buyer, seller, _, _, room = make_room(client_factory, post_headers, test_ns, "cache")
    get_response = buyer.get(f"/api/chat-rooms/{room['id']}/messages")
    post_response = send(seller, post_headers, room["id"], str(uuid.uuid4()), f"{test_ns}-secret-body")
    list_response = buyer.get("/api/chat-rooms")
    room_response = buyer.get(f"/api/chat-rooms/{room['id']}")
    assert get_response.headers["cache-control"] == "no-store"
    assert post_response.headers["cache-control"] == "no-store"
    assert list_response.headers["cache-control"] == "no-store"
    assert room_response.headers["cache-control"] == "no-store"
    assert post_response.status_code == 201


def test_derive_chat_status_table() -> None:
    from app.services.chat import derive_chat_status

    assert derive_chat_status("pending", "open") == "active"
    assert derive_chat_status("accepted", "matched") == "matched"
    assert derive_chat_status("closed", "matched") == "closed"
    assert derive_chat_status("pending", "matched") == "closed"
    assert derive_chat_status("pending", "closed") == "closed"
    assert derive_chat_status("unknown", "open") == "closed"
