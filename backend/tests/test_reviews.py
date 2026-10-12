from __future__ import annotations

import json
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import text

from _application_support import apply, assert_error, complete, create_request, get_reviews, post_review, signup
from conftest import ns_email
from test_matching import confirm


def prepare_completed_trade(client_factory, post_headers, test_ns, label="reviews"):
    buyer = client_factory()
    seller = client_factory()
    buyer_user = signup(buyer, post_headers, test_ns, f"{label}-buyer")
    seller_user = signup(seller, post_headers, test_ns, f"{label}-seller")
    request = create_request(buyer, post_headers, test_ns, label)
    application_response = apply(seller, post_headers, request["id"])
    assert application_response.status_code == 201, application_response.text
    application = application_response.json()["application"]
    assert confirm(buyer, post_headers, request["id"], application["id"]).status_code == 200
    assert complete(buyer, post_headers, request["id"]).status_code == 200
    return buyer, seller, request, application, buyer_user, seller_user



def test_public_reviews_are_visible_without_exposing_reviewer_identity(
    client_factory, post_headers, test_ns, db_engine
):
    buyer, seller, request, application, buyer_user, seller_user = prepare_completed_trade(
        client_factory, post_headers, test_ns, "public-review"
    )
    anonymous = client_factory()
    assert get_reviews(buyer, request["id"]).json()["canWrite"] is True
    assert get_reviews(seller, request["id"]).json()["canWrite"] is True
    buyer_email = ns_email(test_ns, "public-review-buyer")
    seller_email = ns_email(test_ns, "public-review-seller")
    buyer_review = post_review(buyer, post_headers, request["id"], 5, "빠르고 친절한 거래였어요.")
    assert buyer_review.status_code == 201
    visible_after_buyer = get_reviews(anonymous, request["id"])
    assert visible_after_buyer.status_code == 200
    assert [item["reviewerRole"] for item in visible_after_buyer.json()["items"]] == ["buyer"]
    seller_review = post_review(seller, post_headers, request["id"], 4, "설명과 같은 상태였습니다.")
    assert buyer_review.status_code == seller_review.status_code == 201

    outsider = client_factory()
    signup(outsider, post_headers, test_ns, "public-review-outsider")
    for viewer, role in ((buyer, "buyer"), (seller, "seller"), (outsider, None), (anonymous, None)):
        response = get_reviews(viewer, request["id"])
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["viewerRole"] == role
        assert payload["canWrite"] is False
        if role is None:
            assert payload["mine"] is payload["received"] is None
        else:
            assert payload["mine"]["reviewerRole"] == role
            assert payload["received"]["reviewerRole"] != role
        assert len(payload["items"]) == 2
        assert {item["body"] for item in payload["items"]} == {
            "빠르고 친절한 거래였어요.",
            "설명과 같은 상태였습니다.",
        }
        assert [item["reviewerRole"] for item in payload["items"]] == ["buyer", "seller"]
        serialized = json.dumps(payload, ensure_ascii=False)
        assert buyer_email not in serialized
        assert seller_email not in serialized
        assert buyer_user["id"] not in serialized
        assert seller_user["id"] not in serialized
        if role is None:
            assert buyer_review.json()["review"]["id"] not in serialized
            assert seller_review.json()["review"]["id"] not in serialized
        for item in payload["items"]:
            assert set(item) == {"reviewerRole", "rating", "body", "createdAt"}
    assert application["chatRoomId"]
    assert get_reviews(outsider, request["id"]).content == get_reviews(anonymous, request["id"]).content
    with db_engine.connect() as connection:
        rows = connection.execute(
            text("SELECT reviewer_role, reviewer_id::text, reviewee_id::text FROM app_private.reviews WHERE request_id=:id"),
            {"id": request["id"]},
        ).mappings().all()
    assert len(rows) == 2
    assert {row["reviewer_id"] for row in rows} == {buyer_user["id"], seller_user["id"]}
    assert {row["reviewee_id"] for row in rows} == {buyer_user["id"], seller_user["id"]}


def test_public_review_get_has_empty_and_uncompleted_states(client_factory, post_headers, test_ns):
    buyer = client_factory()
    signup(buyer, post_headers, test_ns, "empty-review-buyer")
    request = create_request(buyer, post_headers, test_ns, "후기 없는 완료 요청")
    outsider = client_factory()
    signup(outsider, post_headers, test_ns, "empty-review-outsider")

    for viewer, expected_role in ((buyer, "buyer"), (outsider, None), (client_factory(), None)):
        response = get_reviews(viewer, request["id"])
        assert response.status_code == 200, response.text
        assert response.json() == {
            "requestId": request["id"],
            "requestStatus": "open",
            "completedAt": None,
            "viewerRole": expected_role,
            "canWrite": False,
            "mine": None,
            "received": None,
            "items": [],
        }


def test_review_requires_completed_transaction(client_factory, post_headers, test_ns):
    buyer = client_factory()
    seller = client_factory()
    signup(buyer, post_headers, test_ns, "review-before-complete-buyer")
    signup(seller, post_headers, test_ns, "review-before-complete-seller")
    request = create_request(buyer, post_headers, test_ns, "완료 전 후기 거부")
    application_response = apply(seller, post_headers, request["id"])
    application = application_response.json()["application"]
    assert confirm(buyer, post_headers, request["id"], application["id"]).status_code == 200

    for client, role in ((buyer, "buyer"), (seller, "seller")):
        response = get_reviews(client, request["id"])
        assert response.status_code == 200
        assert response.json()["viewerRole"] == role
        assert response.json()["items"] == []
        assert response.json()["canWrite"] is False
        assert response.json()["mine"] is response.json()["received"] is None
        assert_error(post_review(client, post_headers, request["id"]), 409, "REQUEST_NOT_COMPLETED")


def test_nonparticipants_can_read_but_cannot_write_reviews(client_factory, post_headers, test_ns):
    buyer, seller, request, _, _, _ = prepare_completed_trade(
        client_factory, post_headers, test_ns, "review-access"
    )
    outsider = client_factory()
    signup(outsider, post_headers, test_ns, "review-outsider")
    anonymous = client_factory()

    missing_request_id = str(uuid.uuid4())
    missing_post = post_review(outsider, post_headers, missing_request_id)
    assert missing_post.status_code == 404
    assert missing_post.json()["error"]["code"] == "NOT_FOUND"
    outsider_post = post_review(outsider, post_headers, request["id"])
    assert outsider_post.status_code == 404
    assert outsider_post.content == missing_post.content
    anonymous_post = post_review(anonymous, post_headers, request["id"])
    assert_error(anonymous_post, 401, "UNAUTHENTICATED")
    for client in (outsider, anonymous):
        assert get_reviews(client, request["id"]).status_code == 200
    missing = get_reviews(anonymous, missing_request_id)
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "NOT_FOUND"
    assert get_reviews(seller, request["id"]).json()["canWrite"] is True
    assert post_review(seller, post_headers, request["id"]).status_code == 201
    assert post_review(buyer, post_headers, request["id"]).status_code == 201


@pytest.mark.parametrize(
    "payload,field",
    [
        ({"rating": 0, "body": "유효한 본문"}, "rating"),
        ({"rating": 6, "body": "유효한 본문"}, "rating"),
        ({"rating": 4.5, "body": "유효한 본문"}, "rating"),
        ({"rating": True, "body": "유효한 본문"}, "rating"),
        ({"rating": "5", "body": "유효한 본문"}, "rating"),
        ({"rating": None, "body": "유효한 본문"}, "rating"),
        ({"body": "유효한 본문"}, "rating"),
        ({"rating": 5}, "body"),
        ({"rating": 5, "body": " x "}, "body"),
        ({"rating": 5, "body": "  "}, "body"),
        ({"rating": 5, "body": "x" * 501}, "body"),
        ({"rating": 5, "body": "후기\u0000오류"}, "body"),
        ({"rating": 5, "body": None}, "body"),
        ({"rating": 5, "body": "유효한 후기", "revieweeId": str(uuid.uuid4())}, None),
    ],
)
def test_review_payload_is_strictly_validated(client_factory, post_headers, test_ns, payload, field):
    buyer, _, request, _, _, _ = prepare_completed_trade(
        client_factory, post_headers, test_ns, "review-validation"
    )
    response = buyer.post(f"/api/requests/{request['id']}/reviews", headers=post_headers, json=payload)
    assert_error(response, 422, "VALIDATION_ERROR")
    if field is not None:
        assert field in response.json()["error"]["fields"]


def test_same_review_retry_is_idempotent_and_changed_content_conflicts(
    client_factory, post_headers, test_ns, db_engine
):
    buyer, _, request, _, _, _ = prepare_completed_trade(
        client_factory, post_headers, test_ns, "review-idempotency"
    )
    first = post_review(buyer, post_headers, request["id"], 4, "  괜찮은 거래  ")
    assert first.status_code == 201, first.text
    same = post_review(buyer, post_headers, request["id"], 4, "괜찮은 거래")
    assert same.status_code == 200, same.text
    assert same.json() == first.json()
    changed = post_review(buyer, post_headers, request["id"], 2, "다른 평가입니다")
    assert_error(changed, 409, "ALREADY_REVIEWED")
    with db_engine.connect() as connection:
        rows = connection.execute(
            text("SELECT rating, body FROM app_private.reviews WHERE request_id=:id"),
            {"id": request["id"]},
        ).mappings().all()
    assert len(rows) == 1
    assert rows[0]["rating"] == 4
    assert rows[0]["body"] == "괜찮은 거래"


def test_concurrent_same_review_submission_creates_one_row(client_factory, post_headers, test_ns, db_engine):
    buyer, _, request, _, _, _ = prepare_completed_trade(
        client_factory, post_headers, test_ns, "rv-dup"
    )
    email = ns_email(test_ns, "rv-dup-buyer")
    clients = [buyer] + [client_factory() for _ in range(5)]
    for client in clients[1:]:
        login = client.post(
            "/api/auth/login",
            headers=post_headers,
            json={"email": email, "password": "potato-pass-123"},
        )
        assert login.status_code == 200
    with ThreadPoolExecutor(max_workers=len(clients)) as executor:
        responses = list(executor.map(
            lambda client: post_review(client, post_headers, request["id"], 5, "동시 요청에도 한 건"), clients
        ))
    assert all(response.status_code in (200, 201) for response in responses)
    assert len({response.json()["review"]["id"] for response in responses}) == 1
    with db_engine.connect() as connection:
        count = connection.scalar(text("SELECT count(*) FROM app_private.reviews WHERE request_id=:id"), {"id": request["id"]})
    assert count == 1


def test_concurrent_different_reviews_have_one_immutable_winner(client_factory, post_headers, test_ns):
    buyer, _, request, _, _, _ = prepare_completed_trade(
        client_factory, post_headers, test_ns, "review-concurrent-conflict"
    )
    email = ns_email(test_ns, "review-concurrent-conflict-buyer")
    clones = [buyer] + [client_factory() for _ in range(4)]
    for client in clones[1:]:
        response = client.post("/api/auth/login", headers=post_headers,
                               json={"email": email, "password": "potato-pass-123"})
        assert response.status_code == 200
    with ThreadPoolExecutor(max_workers=len(clones)) as executor:
        responses = list(executor.map(
            lambda pair: post_review(pair[0], post_headers, request["id"], pair[1], f"평가 {pair[1]}"),
            zip(clones, range(1, len(clones) + 1)),
        ))
    assert sum(response.status_code == 201 for response in responses) == 1
    assert sum(response.status_code == 409 for response in responses) == len(clones) - 1
    assert all(response.json()["error"]["code"] == "ALREADY_REVIEWED" for response in responses if response.status_code == 409)


def test_optional_auth_failure_is_equivalent_to_anonymous_without_cookie_mutation(
    client_factory, post_headers, test_ns
):
    buyer, _, request, _, _, _ = prepare_completed_trade(
        client_factory, post_headers, test_ns, "review-optional-auth"
    )
    anonymous = client_factory()
    anon_response = get_reviews(anonymous, request["id"])
    assert anon_response.status_code == 200

    invalid_cookie = client_factory()
    invalid_cookie.cookies.set("gamja_session", "invalid-session-token")
    invalid_response = get_reviews(invalid_cookie, request["id"])
    assert invalid_response.status_code == 200
    assert invalid_response.content == anon_response.content
    assert "set-cookie" not in invalid_response.headers
    assert get_reviews(buyer, request["id"]).json()["viewerRole"] == "buyer"
