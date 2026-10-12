from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import text

from _application_support import apply, create_request, signup
from test_matching import confirm


def test_send_waiting_on_completion_rechecks_status_after_lock_release(
    client_factory, post_headers, test_ns, db_engine, wait_until_blocked_by
):
    buyer = client_factory()
    seller = client_factory()
    signup(buyer, post_headers, test_ns, "completion-send-race-buyer")
    signup(seller, post_headers, test_ns, "completion-send-race-seller")
    request = create_request(buyer, post_headers, test_ns, "완료와 메시지 전송 직렬화")
    application_response = apply(seller, post_headers, request["id"])
    assert application_response.status_code == 201, application_response.text
    application = application_response.json()["application"]
    assert confirm(buyer, post_headers, request["id"], application["id"]).status_code == 200

    message_id = str(uuid.uuid4())
    with db_engine.connect() as controller:
        transaction = controller.begin()
        controller.execute(
            text("SELECT id FROM app_private.purchase_requests WHERE id=:id FOR NO KEY UPDATE"),
            {"id": request["id"]},
        )
        controller.execute(
            text("SELECT id FROM app_private.seller_applications WHERE id=:id FOR UPDATE"),
            {"id": application["id"]},
        )
        controller.execute(
            text(
                "WITH completion AS (SELECT clock_timestamp() AS completed_at) "
                "UPDATE app_private.purchase_requests "
                "SET status='completed', completed_at=completion.completed_at, updated_at=completion.completed_at "
                "FROM completion WHERE id=:id"
            ),
            {"id": request["id"]},
        )
        controller_pid = controller.scalar(text("SELECT pg_backend_pid()"))
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(
                seller.post,
                f"/api/chat-rooms/{application['chatRoomId']}/messages",
                headers=post_headers,
                json={"clientMessageId": message_id, "body": "완료 직후 메시지"},
            )
            wait_until_blocked_by(controller_pid)
            transaction.commit()
            response = future.result(timeout=10)

    assert response.status_code == 409, response.text
    assert response.json()["error"]["code"] == "CHAT_ROOM_CLOSED"
    with db_engine.connect() as connection:
        count = connection.scalar(
            text("SELECT count(*) FROM app_private.chat_messages WHERE client_message_id=:id"),
            {"id": message_id},
        )
    assert count == 0
