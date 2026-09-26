from __future__ import annotations

import os
import inspect as python_inspect
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

from _application_support import (
    APPLICATION_MESSAGE,
    apply,
    assert_error,
    assert_owned_invariants,
    create_request,
    fire_concurrently,
    owned_counts,
    signup,
)
from conftest import ns_email


def concurrency_n() -> int:
    value = int(os.environ.get("GAMJA_CONCURRENCY_N", "16"))
    if not 2 <= value <= 40:
        pytest.fail("GAMJA_CONCURRENCY_N은 2 이상 40 이하이어야 합니다")
    return value


def login(client, post_headers, email: str) -> None:
    response = client.post(
        "/api/auth/login",
        headers=post_headers,
        json={"email": email, "password": "potato-pass-123"},
    )
    assert response.status_code == 200, response.text


def test_n_distinct_sellers_apply_concurrently(
    client_factory, post_headers, test_ns, db_engine
) -> None:
    buyer = client_factory()
    signup(buyer, post_headers, test_ns, "n-buyer")
    request = create_request(buyer, post_headers, test_ns, "N명 동시 지원")
    sellers = [client_factory() for _ in range(concurrency_n())]
    for index, seller in enumerate(sellers):
        signup(seller, post_headers, test_ns, f"n-seller-{index:02d}")

    responses = fire_concurrently(
        [
            lambda seller=seller, index=index: apply(
                seller, post_headers, request["id"], index
            )
            for index, seller in enumerate(sellers)
        ]
    )

    assert [response.status_code for response in responses] == [201] * len(sellers)
    bodies = [response.json() for response in responses]
    application_ids = {body["application"]["id"] for body in bodies}
    room_ids = {body["chatRoom"]["id"] for body in bodies}
    assert len(application_ids) == len(room_ids) == len(sellers)
    assert owned_counts(db_engine, request["id"]) == (len(sellers), len(sellers))
    owner_list = buyer.get(f"/api/requests/{request['id']}/applications").json()
    assert owner_list["applicantCount"] == len(sellers)
    assert len(owner_list["items"]) == len(sellers)
    assert_owned_invariants(db_engine, [request["id"]])


@pytest.mark.parametrize("attempt", range(3))
def test_same_seller_parallel_duplicates_single_winner(
    client_factory, post_headers, test_ns, db_engine, attempt
) -> None:
    buyer = client_factory()
    signup(buyer, post_headers, test_ns, f"dup-buyer-{attempt}")
    request = create_request(buyer, post_headers, test_ns, f"동일 판매자 경쟁 {attempt}")
    primary = client_factory()
    email = ns_email(test_ns, f"dup-seller-{attempt}")
    signup(primary, post_headers, test_ns, f"dup-seller-{attempt}")
    seller_clients = [primary] + [client_factory() for _ in range(7)]
    for clone in seller_clients[1:]:
        login(clone, post_headers, email)

    responses = fire_concurrently(
        [
            lambda seller=seller, index=index: apply(
                seller, post_headers, request["id"], index
            )
            for index, seller in enumerate(seller_clients)
        ]
    )
    statuses = [response.status_code for response in responses]
    assert statuses.count(201) == 1
    assert statuses.count(409) == 7
    assert all(
        response.status_code == 201
        or response.json()["error"]["code"] == "ALREADY_APPLIED"
        for response in responses
    )
    assert owned_counts(db_engine, request["id"]) == (1, 1)


def test_mixed_self_duplicate_and_distinct(
    client_factory, post_headers, test_ns, db_engine
) -> None:
    buyer = client_factory()
    signup(buyer, post_headers, test_ns, "mixed-buyer")
    request = create_request(buyer, post_headers, test_ns, "혼합 경쟁")
    seller_a = client_factory()
    seller_a_email = ns_email(test_ns, "mixed-seller-a")
    signup(seller_a, post_headers, test_ns, "mixed-seller-a")
    seller_a_clones = [seller_a, client_factory(), client_factory()]
    for clone in seller_a_clones[1:]:
        login(clone, post_headers, seller_a_email)
    other_sellers = [client_factory() for _ in range(4)]
    for index, seller in enumerate(other_sellers):
        signup(seller, post_headers, test_ns, f"mixed-seller-{index}")

    calls = [lambda: apply(buyer, post_headers, request["id"], 90) for _ in range(2)]
    calls += [
        lambda seller=seller, index=index: apply(seller, post_headers, request["id"], index)
        for index, seller in enumerate(seller_a_clones)
    ]
    calls += [
        lambda seller=seller, index=index: apply(seller, post_headers, request["id"], index + 10)
        for index, seller in enumerate(other_sellers)
    ]
    responses = fire_concurrently(calls)
    statuses = [response.status_code for response in responses]
    assert statuses.count(403) == 2
    assert statuses.count(201) == 5
    assert statuses.count(409) == 2
    assert owned_counts(db_engine, request["id"]) == (5, 5)
    assert_owned_invariants(db_engine, [request["id"]])


def test_apply_waits_for_uncommitted_close_then_rejects(
    client_factory, post_headers, test_ns, db_engine, wait_until_blocked_by
) -> None:
    buyer = client_factory()
    seller = client_factory()
    signup(buyer, post_headers, test_ns, "close-buyer")
    signup(seller, post_headers, test_ns, "close-seller")
    request = create_request(buyer, post_headers, test_ns, "마감 잠금 경쟁")

    with db_engine.connect() as controller:
        transaction = controller.begin()
        controller.execute(
            text(
                "UPDATE app_private.purchase_requests SET status = 'closed' "
                "WHERE id = :request_id"
            ),
            {"request_id": request["id"]},
        )
        controller_pid = controller.scalar(text("SELECT pg_backend_pid()"))
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(apply, seller, post_headers, request["id"])
            wait_until_blocked_by(controller_pid)
            transaction.commit()
            response = future.result(timeout=10)
    assert_error(response, 409, "REQUEST_NOT_OPEN")
    assert owned_counts(db_engine, request["id"]) == (0, 0)


def test_apply_waits_for_row_lock_then_succeeds(
    client_factory, post_headers, test_ns, db_engine, wait_until_blocked_by
) -> None:
    buyer = client_factory()
    seller = client_factory()
    signup(buyer, post_headers, test_ns, "rowlock-buyer")
    signup(seller, post_headers, test_ns, "rowlock-seller")
    request = create_request(buyer, post_headers, test_ns, "행 잠금 경쟁")

    with db_engine.connect() as controller:
        transaction = controller.begin()
        controller.execute(
            text(
                "SELECT id FROM app_private.purchase_requests "
                "WHERE id = :request_id FOR NO KEY UPDATE"
            ),
            {"request_id": request["id"]},
        )
        controller_pid = controller.scalar(text("SELECT pg_backend_pid()"))
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(apply, seller, post_headers, request["id"])
            wait_until_blocked_by(controller_pid)
            transaction.commit()
            response = future.result(timeout=10)
    assert response.status_code == 201, response.text
    assert owned_counts(db_engine, request["id"]) == (1, 1)


def test_status_lock_is_blocked_while_application_in_flight(
    client_factory, post_headers, test_ns, db_engine, monkeypatch
) -> None:
    from app.repositories import applications

    buyer = client_factory()
    seller = client_factory()
    signup(buyer, post_headers, test_ns, "held-buyer")
    signup(seller, post_headers, test_ns, "held-seller")
    request = create_request(buyer, post_headers, test_ns, "지원 잠금 보유")
    acquired = threading.Event()
    release = threading.Event()
    original = applications.lock_request_for_application

    def pause_after_acquire(*args, **kwargs):
        result = original(*args, **kwargs)
        acquired.set()
        if not release.wait(timeout=5):
            raise TimeoutError("test did not release application lock")
        return result

    with monkeypatch.context() as patch:
        patch.setattr(applications, "lock_request_for_application", pause_after_acquire)
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(apply, seller, post_headers, request["id"])
            assert acquired.wait(timeout=5)
            with db_engine.connect() as controller:
                transaction = controller.begin()
                controller.execute(text("SET LOCAL lock_timeout = '300ms'"))
                with pytest.raises(OperationalError) as caught:
                    controller.execute(
                        text(
                            "SELECT id FROM app_private.purchase_requests "
                            "WHERE id = :request_id FOR NO KEY UPDATE"
                        ),
                        {"request_id": request["id"]},
                    )
                assert caught.value.orig.sqlstate == "55P03"
                transaction.rollback()
            release.set()
            response = future.result(timeout=10)
    assert response.status_code == 201, response.text


@pytest.mark.parametrize("commit_first", [False, True])
def test_duplicate_waits_for_preceding_transaction(
    client_factory,
    post_headers,
    test_ns,
    db_engine,
    wait_until_blocked_by,
    commit_first,
) -> None:
    buyer = client_factory()
    seller = client_factory()
    buyer_user = signup(buyer, post_headers, test_ns, f"tx-buyer-{commit_first}")
    seller_user = signup(seller, post_headers, test_ns, f"tx-seller-{commit_first}")
    request = create_request(buyer, post_headers, test_ns, f"선행 트랜잭션 {commit_first}")
    application_id = uuid.uuid4()
    room_id = uuid.uuid4()

    with db_engine.connect() as controller:
        transaction = controller.begin()
        controller.execute(
            text(
                "INSERT INTO app_private.seller_applications "
                "(id, request_id, buyer_id, seller_id, offer_price, message) "
                "VALUES (:id, :request_id, :buyer_id, :seller_id, 710000, :message)"
            ),
            {
                "id": application_id,
                "request_id": request["id"],
                "buyer_id": buyer_user["id"],
                "seller_id": seller_user["id"],
                "message": APPLICATION_MESSAGE,
            },
        )
        if commit_first:
            controller.execute(
                text(
                    "INSERT INTO app_private.chat_rooms (id, application_id) "
                    "VALUES (:id, :application_id)"
                ),
                {"id": room_id, "application_id": application_id},
            )
        controller_pid = controller.scalar(text("SELECT pg_backend_pid()"))
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(apply, seller, post_headers, request["id"])
            wait_until_blocked_by(controller_pid)
            if commit_first:
                transaction.commit()
            else:
                # This is the approved rollback of a deliberately uncommitted INSERT.
                transaction.rollback()
            response = future.result(timeout=10)

    if commit_first:
        assert_error(response, 409, "ALREADY_APPLIED")
    else:
        assert response.status_code == 201, response.text
    assert owned_counts(db_engine, request["id"]) == (1, 1)


def test_lock_timeout_returns_503_then_retry_succeeds(
    client_factory,
    post_headers,
    test_ns,
    db_engine,
    wait_until_blocked_by,
) -> None:
    from app.core.config import get_settings
    from app.main import app

    buyer = client_factory()
    seller = client_factory()
    signup(buyer, post_headers, test_ns, "timeout-buyer")
    signup(seller, post_headers, test_ns, "timeout-seller")
    request = create_request(buyer, post_headers, test_ns, "잠금 제한 시간")
    settings = get_settings().model_copy(update={"application_lock_timeout_ms": 300})
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        with db_engine.connect() as controller:
            transaction = controller.begin()
            controller.execute(
                text(
                    "SELECT id FROM app_private.purchase_requests "
                    "WHERE id = :request_id FOR UPDATE"
                ),
                {"request_id": request["id"]},
            )
            controller_pid = controller.scalar(text("SELECT pg_backend_pid()"))
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(apply, seller, post_headers, request["id"])
                wait_until_blocked_by(controller_pid)
                response = future.result(timeout=10)
            assert_error(response, 503, "SERVICE_UNAVAILABLE")
            assert owned_counts(db_engine, request["id"]) == (0, 0)
            transaction.commit()
    finally:
        app.dependency_overrides.pop(get_settings, None)
    retry = apply(seller, post_headers, request["id"])
    assert retry.status_code == 201, retry.text


def test_cross_request_parallel_counts_are_isolated(
    client_factory, post_headers, test_ns, db_engine
) -> None:
    buyer = client_factory()
    signup(buyer, post_headers, test_ns, "cross-buyer")
    requests = [
        create_request(buyer, post_headers, test_ns, f"교차 동시 지원 {index}")
        for index in range(3)
    ]
    seller_count = 6
    # One TestClient per HTTP call: no cookie jar or portal is shared across
    # the 18 worker threads, while the same six seller identities span requests.
    per_request_clients: list[list] = [[] for _ in requests]
    for seller_index in range(seller_count):
        primary = client_factory()
        email = ns_email(test_ns, f"cross-seller-{seller_index}")
        signup(primary, post_headers, test_ns, f"cross-seller-{seller_index}")
        per_request_clients[0].append(primary)
        for request_index in range(1, len(requests)):
            clone = client_factory()
            login(clone, post_headers, email)
            per_request_clients[request_index].append(clone)

    calls = [
        lambda call_client=per_request_clients[request_index][seller_index],
        request_id=request["id"],
        call_index=request_index * seller_count + seller_index: apply(
            call_client, post_headers, request_id, call_index
        )
        for request_index, request in enumerate(requests)
        for seller_index in range(seller_count)
    ]
    responses = fire_concurrently(calls)

    assert [response.status_code for response in responses] == [201] * len(calls)
    request_ids = [request["id"] for request in requests]
    with db_engine.connect() as connection:
        counts = connection.execute(
            text(
                "SELECT a.request_id, count(DISTINCT a.id) AS applications, "
                "       count(r.id) AS rooms "
                "FROM app_private.seller_applications a "
                "LEFT JOIN app_private.chat_rooms r ON r.application_id = a.id "
                "WHERE a.request_id = ANY(:request_ids) "
                "GROUP BY a.request_id"
            ),
            {"request_ids": request_ids},
        ).mappings()
        by_request = {
            str(row["request_id"]): (int(row["applications"]), int(row["rooms"]))
            for row in counts
        }
    assert by_request == {
        request_id: (seller_count, seller_count) for request_id in request_ids
    }
    for request_id in request_ids:
        owner_view = buyer.get(f"/api/requests/{request_id}/applications")
        assert owner_view.status_code == 200, owner_view.text
        assert owner_view.json()["applicantCount"] == seller_count
        assert len(owner_view.json()["items"]) == seller_count
    assert_owned_invariants(db_engine, request_ids)


def test_concurrent_room_failures_roll_back_only_target_sellers(
    client_factory, post_headers, test_ns, db_engine, monkeypatch
) -> None:
    from app.repositories import chat_rooms

    buyer = client_factory()
    signup(buyer, post_headers, test_ns, "atomic-buyer")
    request = create_request(buyer, post_headers, test_ns, "혼합 원자성")
    sellers = [client_factory() for _ in range(8)]
    seller_ids: list[str] = []
    for index, seller in enumerate(sellers):
        user = signup(seller, post_headers, test_ns, f"atomic-seller-{index}")
        seller_ids.append(user["id"])
    failing_seller_ids = set(seller_ids[::2])
    successful_seller_ids = set(seller_ids[1::2])
    original = chat_rooms.create_for_application
    signature = python_inspect.signature(original)

    def fail_selected_seller(*args, **kwargs):
        bound = signature.bind_partial(*args, **kwargs)
        db = bound.arguments["db"]
        application_id = bound.arguments["application_id"]
        seller_id = db.scalar(
            text(
                "SELECT seller_id FROM app_private.seller_applications "
                "WHERE id = :application_id"
            ),
            {"application_id": application_id},
        )
        if str(seller_id) in failing_seller_ids:
            # A real PG FK failure aborts only this request transaction; the
            # target set comes from seller identity, never a shared call count.
            db.execute(
                text(
                    "INSERT INTO app_private.chat_rooms (id, application_id) "
                    "VALUES (:id, :application_id)"
                ),
                {"id": uuid.uuid4(), "application_id": uuid.uuid4()},
            )
        return original(*args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(chat_rooms, "create_for_application", fail_selected_seller)
        responses = fire_concurrently(
            [
                lambda seller=seller, index=index: apply(
                    seller, post_headers, request["id"], index
                )
                for index, seller in enumerate(sellers)
            ]
        )

    response_by_seller = dict(zip(seller_ids, responses, strict=True))
    assert {
        seller_id: response.status_code
        for seller_id, response in response_by_seller.items()
    } == {
        seller_id: (503 if seller_id in failing_seller_ids else 201)
        for seller_id in seller_ids
    }
    assert all(
        response.json()["error"]["code"] == "SERVICE_UNAVAILABLE"
        for seller_id, response in response_by_seller.items()
        if seller_id in failing_seller_ids
    )
    with db_engine.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT a.seller_id, count(r.id) AS room_count "
                "FROM app_private.seller_applications a "
                "LEFT JOIN app_private.chat_rooms r ON r.application_id = a.id "
                "WHERE a.request_id = :request_id "
                "GROUP BY a.seller_id"
            ),
            {"request_id": request["id"]},
        ).mappings()
        persisted = {str(row["seller_id"]): int(row["room_count"]) for row in rows}
    assert persisted == {seller_id: 1 for seller_id in successful_seller_ids}
    assert_owned_invariants(db_engine, [request["id"]])

    # Rolled-back sellers have no unique residue and can retry after injection ends.
    for index, seller in enumerate(sellers):
        if seller_ids[index] in failing_seller_ids:
            retry = apply(seller, post_headers, request["id"], index + 100)
            assert retry.status_code == 201, retry.text
    assert owned_counts(db_engine, request["id"]) == (len(sellers), len(sellers))
    assert_owned_invariants(db_engine, [request["id"]])
