from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import text

from _application_support import apply, assert_error, create_request, fire_concurrently, signup
from test_chat_messages import make_room, send
from test_matching import confirm, make_applications
from conftest import ns_email


def login(client, post_headers, email: str) -> None:
    response = client.post(
        "/api/auth/login",
        headers=post_headers,
        json={"email": email, "password": "potato-pass-123"},
    )
    assert response.status_code == 200, response.text


def test_concurrent_confirm_different_applications_single_winner(
    client_factory, post_headers, test_ns, db_engine
) -> None:
    for attempt in range(3):
        buyer, request, _, applications = make_applications(
            client_factory, post_headers, test_ns, label=f"parallel-match-{attempt}"
        )
        responses = fire_concurrently(
            [
                lambda item=item: confirm(buyer, post_headers, request["id"], item["id"])
                for item in applications
            ]
        )
        statuses = [response.status_code for response in responses]
        assert statuses.count(200) == 1
        assert statuses.count(409) == 1
        assert all(
            response.status_code == 200
            or response.json()["error"]["code"] == "REQUEST_ALREADY_MATCHED"
            for response in responses
        )
        with db_engine.connect() as connection:
            state = connection.execute(
                text("SELECT status, count(*) OVER () AS accepted_count FROM app_private.seller_applications WHERE request_id=:id AND status='accepted'"),
                {"id": request["id"]},
            ).mappings().all()
        assert len(state) == 1
        assert state[0]["status"] == "accepted"


def test_concurrent_confirm_same_application_is_idempotent(
    client_factory, post_headers, test_ns, db_engine
) -> None:
    buyer, request, _, applications = make_applications(
        client_factory, post_headers, test_ns, label="parallel-same"
    )
    buyer_email = ns_email(test_ns, "parallel-same-buyer")
    buyers = [buyer] + [client_factory() for _ in range(7)]
    for clone in buyers[1:]:
        login(clone, post_headers, buyer_email)
    responses = fire_concurrently(
        [
            lambda client=client: confirm(client, post_headers, request["id"], applications[0]["id"])
            for client in buyers
        ]
    )
    assert [response.status_code for response in responses] == [200] * len(buyers)
    assert all(response.json() == responses[0].json() for response in responses)
    with db_engine.connect() as connection:
        accepted_count = connection.scalar(
            text("SELECT count(*) FROM app_private.seller_applications WHERE request_id=:id AND status='accepted'"),
            {"id": request["id"]},
        )
    assert accepted_count == 1


def test_match_racing_new_applications_leaves_no_pending(
    client_factory, post_headers, test_ns, db_engine
) -> None:
    buyer = client_factory()
    signup(buyer, post_headers, test_ns, "race-buyer")
    request = create_request(buyer, post_headers, test_ns, "매칭과 신규 지원 경쟁")
    initial_seller = client_factory()
    signup(initial_seller, post_headers, test_ns, "race-initial-seller")
    initial = apply(initial_seller, post_headers, request["id"])
    assert initial.status_code == 201
    sellers = [client_factory() for _ in range(16)]
    for index, seller in enumerate(sellers):
        signup(seller, post_headers, test_ns, f"race-seller-{index}")
    calls = [
        lambda seller=seller, index=index: apply(seller, post_headers, request["id"], index)
        for index, seller in enumerate(sellers)
    ]
    calls.append(lambda: confirm(buyer, post_headers, request["id"], initial.json()["application"]["id"]))
    responses = fire_concurrently(calls)
    match_response = responses[-1]
    assert match_response.status_code == 200, match_response.text
    apply_responses = responses[:-1]
    assert all(response.status_code in (201, 409) for response in apply_responses)
    assert all(
        response.status_code == 201 or response.json()["error"]["code"] == "REQUEST_NOT_OPEN"
        for response in apply_responses
    )
    successful_ids = {response.json()["application"]["id"] for response in apply_responses if response.status_code == 201}
    with db_engine.connect() as connection:
        counts = connection.execute(
            text("SELECT count(*) FILTER (WHERE status='pending') AS pending, count(*) FILTER (WHERE status='accepted') AS accepted, count(*) FILTER (WHERE status='closed') AS closed FROM app_private.seller_applications WHERE request_id=:id"),
            {"id": request["id"]},
        ).mappings().one()
    assert counts["pending"] == 0
    assert counts["accepted"] == 1
    assert counts["closed"] == len(successful_ids)


def test_apply_waits_for_match_then_is_rejected(
    client_factory, post_headers, test_ns, db_engine, wait_until_blocked_by
) -> None:
    buyer, request, _, applications = make_applications(client_factory, post_headers, test_ns, 1)
    seller = client_factory()
    signup(seller, post_headers, test_ns, "wait-apply-seller")
    with db_engine.connect() as controller:
        transaction = controller.begin()
        controller.execute(
            text("SELECT id FROM app_private.purchase_requests WHERE id=:id FOR NO KEY UPDATE"),
            {"id": request["id"]},
        )
        controller_pid = controller.scalar(text("SELECT pg_backend_pid()"))
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(apply, seller, post_headers, request["id"])
            wait_until_blocked_by(controller_pid)
            controller.execute(text("UPDATE app_private.purchase_requests SET status='matched' WHERE id=:id"), {"id": request["id"]})
            transaction.commit()
            response = future.result(timeout=10)
    assert_error(response, 409, "REQUEST_NOT_OPEN")
    assert confirm(buyer, post_headers, request["id"], applications[0]["id"]).status_code == 409


def test_send_waits_for_close_then_is_rejected(
    client_factory, post_headers, test_ns, db_engine, wait_until_blocked_by
) -> None:
    buyer, seller, _, application, room = make_room(client_factory, post_headers, test_ns, "wait-send")
    with db_engine.connect() as controller:
        transaction = controller.begin()
        controller.execute(
            text("UPDATE app_private.seller_applications SET status='closed', decided_at=now() WHERE id=:id"),
            {"id": application["id"]},
        )
        controller_pid = controller.scalar(text("SELECT pg_backend_pid()"))
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(send, seller, post_headers, room["id"], str(uuid.uuid4()), "close race")
            wait_until_blocked_by(controller_pid)
            transaction.commit()
            response = future.result(timeout=10)
    assert_error(response, 409, "CHAT_ROOM_CLOSED")
    assert buyer.get(f"/api/chat-rooms/{room['id']}/messages").json()["items"] == []


def test_concurrent_sends_have_contiguous_sequence(client_factory, post_headers, test_ns, db_engine) -> None:
    buyer, seller, _, _, room = make_room(client_factory, post_headers, test_ns, "parallel-send")
    senders = [buyer] * 10 + [seller] * 10
    responses = fire_concurrently(
        [
            lambda client=client, index=index: send(
                client, post_headers, room["id"], str(uuid.uuid4()), f"parallel {index}"
            )
            for index, client in enumerate(senders)
        ]
    )
    assert [response.status_code for response in responses] == [201] * 20
    with db_engine.connect() as connection:
        seqs = connection.execute(
            text("SELECT seq FROM app_private.chat_messages WHERE room_id=:id ORDER BY seq"),
            {"id": room["id"]},
        ).scalars().all()
    assert seqs == list(range(1, 21))


def test_polling_never_skips_messages(client_factory, post_headers, test_ns, db_engine) -> None:
    buyer, seller, _, _, room = make_room(client_factory, post_headers, test_ns, "poll-race")
    messages = 100
    senders = [seller, buyer, seller, buyer]
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [
            executor.submit(
                lambda client=client, index=index: send(
                    client, post_headers, room["id"], str(uuid.uuid4()), f"poll {index}"
                )
            )
            for index in range(messages)
            for client in [senders[index % len(senders)]]
        ]
        cursor = 0
        collected: list[int] = []
        while any(not future.done() for future in futures) or cursor < messages:
            page = buyer.get(f"/api/chat-rooms/{room['id']}/messages?afterSeq={cursor}&limit=50")
            assert page.status_code == 200, page.text
            seqs = [item["seq"] for item in page.json()["items"]]
            assert seqs == sorted(set(seqs))
            collected.extend(seqs)
            if seqs:
                cursor = seqs[-1]
            else:
                # Allow the in-flight writers to make progress without creating more DB work.
                for future in futures:
                    if future.done():
                        assert future.result(timeout=1).status_code == 201
                if cursor == messages:
                    break
        for future in futures:
            assert future.result(timeout=10).status_code == 201
    assert collected == list(range(1, messages + 1))
