from __future__ import annotations

import io
import json
import uuid
from dataclasses import dataclass
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi.testclient import TestClient
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from _application_support import (
    APPLICATION_MESSAGE,
    apply,
    apply_payload,
    assert_error,
    assert_original_emails_absent,
    assert_owned_invariants,
    create_request,
    owned_counts,
    signup,
)
from conftest import ALEMBIC_INI, ns_email


@dataclass
class Parties:
    buyer: TestClient
    seller: TestClient
    outsider: TestClient
    buyer_user: dict[str, Any]
    seller_user: dict[str, Any]
    outsider_user: dict[str, Any]
    request: dict[str, Any]


@pytest.fixture
def parties(client_factory, post_headers, test_ns) -> Parties:
    buyer = client_factory()
    seller = client_factory()
    outsider = client_factory()
    buyer_user = signup(buyer, post_headers, test_ns, "buyer")
    seller_user = signup(seller, post_headers, test_ns, "seller")
    outsider_user = signup(outsider, post_headers, test_ns, "outsider")
    request = create_request(buyer, post_headers, test_ns)
    return Parties(
        buyer,
        seller,
        outsider,
        buyer_user,
        seller_user,
        outsider_user,
        request,
    )


def test_apply_creates_application_and_room(parties, post_headers, db_engine, test_ns) -> None:
    response = apply(parties.seller, post_headers, parties.request["id"])

    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    application = body["application"]
    room = body["chatRoom"]
    assert application["requestId"] == parties.request["id"]
    assert application["seller"]["id"] == parties.seller_user["id"]
    assert application["chatRoomId"] == room["id"]
    assert room["applicationId"] == application["id"]
    assert room["viewerRole"] == "seller"
    assert application["offerPrice"] == 700_000
    assert application["message"] == f"{APPLICATION_MESSAGE} (0)"
    assert set(application) == {
        "id", "requestId", "seller", "offerPrice", "message", "chatRoomId", "createdAt"
    }
    assert_original_emails_absent(
        response,
        ns_email(test_ns, "buyer"),
        ns_email(test_ns, "seller"),
    )
    assert owned_counts(db_engine, parties.request["id"]) == (1, 1)
    assert_owned_invariants(db_engine, [parties.request["id"]])


def test_apply_security_and_authentication(parties, client_factory, post_headers, db_engine) -> None:
    anonymous = client_factory()
    unauthenticated = apply(anonymous, post_headers, parties.request["id"])
    assert_error(unauthenticated, 401, "UNAUTHENTICATED")

    no_origin = {key: value for key, value in post_headers.items() if key != "Origin"}
    assert_error(
        parties.seller.post(
            f"/api/requests/{parties.request['id']}/applications",
            headers=no_origin,
            json=apply_payload(),
        ),
        403,
        "INVALID_ORIGIN",
    )
    plain_headers = {**post_headers, "Content-Type": "text/plain"}
    assert_error(
        parties.seller.post(
            f"/api/requests/{parties.request['id']}/applications",
            headers=plain_headers,
            content=json.dumps(apply_payload()),
        ),
        415,
        "UNSUPPORTED_MEDIA_TYPE",
    )
    assert owned_counts(db_engine, parties.request["id"]) == (0, 0)


@pytest.mark.parametrize(
    ("payload", "field"),
    [
        ({"offerPrice": -1, "message": "유효한 메시지"}, "offerPrice"),
        ({"offerPrice": 1_000_000_001, "message": "유효한 메시지"}, "offerPrice"),
        ({"offerPrice": 1.5, "message": "유효한 메시지"}, "offerPrice"),
        ({"offerPrice": "1000", "message": "유효한 메시지"}, "offerPrice"),
        ({"message": "유효한 메시지"}, "offerPrice"),
        ({"offerPrice": 1000, "message": "한"}, "message"),
        ({"offerPrice": 1000, "message": " " * 5}, "message"),
        ({"offerPrice": 1000, "message": "가" * 501}, "message"),
        ({"offerPrice": 1000}, "message"),
    ],
)
def test_apply_validation_boundaries(parties, post_headers, payload, field) -> None:
    response = parties.seller.post(
        f"/api/requests/{parties.request['id']}/applications",
        headers=post_headers,
        json=payload,
    )
    assert_error(response, 422, "VALIDATION_ERROR")
    assert field in response.json()["error"]["fields"]


@pytest.mark.parametrize(
    "field", ["requestId", "sellerId", "buyerId", "chatRoomId", "status"]
)
def test_apply_rejects_server_controlled_fields(parties, post_headers, field) -> None:
    response = parties.seller.post(
        f"/api/requests/{parties.request['id']}/applications",
        headers=post_headers,
        json={**apply_payload(), field: str(uuid.uuid4())},
    )
    assert_error(response, 422, "VALIDATION_ERROR")


def test_apply_forbids_self_and_rejects_duplicate(parties, post_headers, db_engine) -> None:
    assert_error(
        apply(parties.buyer, post_headers, parties.request["id"]),
        403,
        "SELF_APPLICATION_FORBIDDEN",
    )
    first = apply(parties.seller, post_headers, parties.request["id"])
    assert first.status_code == 201, first.text
    second = apply(parties.seller, post_headers, parties.request["id"], 99)
    assert_error(second, 409, "ALREADY_APPLIED")
    assert owned_counts(db_engine, parties.request["id"]) == (1, 1)
    stored = first.json()["application"]
    listed = parties.seller.get(
        f"/api/requests/{parties.request['id']}/applications"
    ).json()
    assert listed["items"] == [stored]


@pytest.mark.parametrize("status", ["closed", "matched"])
def test_apply_rejects_non_open_request(parties, post_headers, db_engine, status) -> None:
    with db_engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE app_private.purchase_requests SET status = :status "
                "WHERE id = :request_id"
            ),
            {"status": status, "request_id": parties.request["id"]},
        )
    assert_error(
        apply(parties.seller, post_headers, parties.request["id"]),
        409,
        "REQUEST_NOT_OPEN",
    )
    assert owned_counts(db_engine, parties.request["id"]) == (0, 0)


def test_application_list_visibility_by_role(
    client_factory, post_headers, test_ns
) -> None:
    buyer = client_factory()
    buyer_user = signup(buyer, post_headers, test_ns, "list-buyer")
    request = create_request(buyer, post_headers, test_ns, "목록 권한 요청")
    sellers = [client_factory() for _ in range(3)]
    applications = []
    for index, seller in enumerate(sellers):
        signup(seller, post_headers, test_ns, f"list-seller-{index}")
        response = apply(seller, post_headers, request["id"], index)
        assert response.status_code == 201, response.text
        applications.append(response.json()["application"])
    outsider = client_factory()
    signup(outsider, post_headers, test_ns, "list-outsider")
    anonymous = client_factory()

    owner_body = buyer.get(f"/api/requests/{request['id']}/applications").json()
    assert owner_body == {
        "viewerRole": "owner",
        "applicantCount": 3,
        "items": applications,
    }
    seller_body = sellers[1].get(f"/api/requests/{request['id']}/applications").json()
    assert seller_body["viewerRole"] == "applicant"
    assert seller_body["items"] == [applications[1]]
    for viewer, role in [(outsider, "member"), (anonymous, "anonymous")]:
        body = viewer.get(f"/api/requests/{request['id']}/applications").json()
        assert body == {"viewerRole": role, "applicantCount": 3, "items": []}
        serialized = json.dumps(body, ensure_ascii=False)
        assert APPLICATION_MESSAGE not in serialized
    assert buyer_user["id"] == request["buyer"]["id"]


def test_invalid_optional_cookie_is_anonymous_without_expiring_cookie(
    parties, client_factory
) -> None:
    viewer = client_factory()
    viewer.cookies.set("gamja_session", "x" * 43)
    response = viewer.get(f"/api/requests/{parties.request['id']}/applications")
    assert response.status_code == 200
    assert response.json() == {
        "viewerRole": "anonymous",
        "applicantCount": 0,
        "items": [],
    }
    assert "set-cookie" not in response.headers


def test_chat_room_access_matrix(parties, client_factory, post_headers) -> None:
    created = apply(parties.seller, post_headers, parties.request["id"])
    assert created.status_code == 201, created.text
    room_id = created.json()["chatRoom"]["id"]
    buyer = parties.buyer.get(f"/api/chat-rooms/{room_id}")
    seller = parties.seller.get(f"/api/chat-rooms/{room_id}")
    outsider = parties.outsider.get(f"/api/chat-rooms/{room_id}")
    anonymous = client_factory().get(f"/api/chat-rooms/{room_id}")
    missing = parties.outsider.get(f"/api/chat-rooms/{uuid.uuid4()}")

    assert buyer.status_code == seller.status_code == 200
    assert buyer.json()["viewerRole"] == "buyer"
    assert seller.json()["viewerRole"] == "seller"
    assert_error(outsider, 404, "NOT_FOUND")
    assert_error(missing, 404, "NOT_FOUND")
    assert outsider.json() == missing.json()
    assert_error(anonymous, 401, "UNAUTHENTICATED")
    assert_error(parties.seller.get("/api/chat-rooms/not-a-uuid"), 422, "VALIDATION_ERROR")


def test_new_endpoints_set_no_store_on_success_and_error(
    parties, post_headers
) -> None:
    created = apply(parties.seller, post_headers, parties.request["id"])
    assert created.status_code == 201, created.text
    room_id = created.json()["chatRoom"]["id"]

    listed = parties.buyer.get(
        f"/api/requests/{parties.request['id']}/applications"
    )
    room = parties.seller.get(f"/api/chat-rooms/{room_id}")
    missing_request = parties.buyer.get(
        f"/api/requests/{uuid.uuid4()}/applications"
    )
    missing_room = parties.seller.get(f"/api/chat-rooms/{uuid.uuid4()}")

    assert listed.status_code == room.status_code == 200
    assert listed.headers["cache-control"] == "no-store"
    assert room.headers["cache-control"] == "no-store"
    assert_error(missing_request, 404, "NOT_FOUND")
    assert_error(missing_room, 404, "NOT_FOUND")


def test_applicant_count_sort_and_request_row_are_correct(
    client_factory, post_headers, test_ns, db_engine
) -> None:
    buyer = client_factory()
    signup(buyer, post_headers, test_ns, "count-buyer")
    requests = [
        create_request(buyer, post_headers, test_ns, f"집계 요청 {index}")
        for index in range(3)
    ]
    before = None
    with db_engine.connect() as connection:
        before = connection.execute(
            text(
                "SELECT status, updated_at FROM app_private.purchase_requests WHERE id = :id"
            ),
            {"id": requests[0]["id"]},
        ).one()
    sellers = [client_factory() for _ in range(3)]
    for index, seller in enumerate(sellers):
        signup(seller, post_headers, test_ns, f"count-seller-{index}")
    for request_index, seller_count in enumerate((2, 1, 0)):
        for seller_index in range(seller_count):
            result = apply(sellers[seller_index], post_headers, requests[request_index]["id"], request_index)
            assert result.status_code == 201, result.text

    listing = buyer.get(
        "/api/requests", params={"q": test_ns, "sort": "applicants"}
    ).json()
    assert listing["total"] == 3
    assert [item["id"] for item in listing["items"]] == [item["id"] for item in requests]
    assert [item["applicantCount"] for item in listing["items"]] == [2, 1, 0]
    assert buyer.get(f"/api/requests/{requests[0]['id']}").json()["applicantCount"] == 2
    with db_engine.connect() as connection:
        after = connection.execute(
            text(
                "SELECT status, updated_at FROM app_private.purchase_requests WHERE id = :id"
            ),
            {"id": requests[0]["id"]},
        ).one()
    assert after == before


def test_db_constraints_reject_self_application(
    parties, rollback_connection
) -> None:
    application_id = uuid.uuid4()
    with pytest.raises(IntegrityError) as caught:
        rollback_connection.execute(
            text(
                "INSERT INTO app_private.seller_applications "
                "(id, request_id, buyer_id, seller_id, offer_price, message) "
                "VALUES (:id, :request_id, :buyer_id, :seller_id, 1000, '유효한 메시지')"
            ),
            {
                "id": application_id,
                "request_id": parties.request["id"],
                "buyer_id": parties.buyer_user["id"],
                "seller_id": parties.buyer_user["id"],
            },
        )
    assert caught.value.orig.diag.constraint_name == "ck_seller_applications_not_self"


def test_db_constraint_rejects_request_buyer_mismatch(
    parties, rollback_connection
) -> None:
    with pytest.raises(IntegrityError) as caught:
        rollback_connection.execute(
            text(
                "INSERT INTO app_private.seller_applications "
                "(id, request_id, buyer_id, seller_id, offer_price, message) "
                "VALUES (:id, :request_id, :buyer_id, :seller_id, 1000, '유효한 메시지')"
            ),
            {
                "id": uuid.uuid4(),
                "request_id": parties.request["id"],
                "buyer_id": parties.outsider_user["id"],
                "seller_id": parties.seller_user["id"],
            },
        )
    assert (
        caught.value.orig.diag.constraint_name
        == "fk_seller_applications_request_buyer"
    )


@pytest.mark.parametrize("offer_price", [-1, 1_000_000_001])
def test_db_constraint_rejects_offer_price_out_of_range(
    parties, rollback_connection, offer_price
) -> None:
    with pytest.raises(IntegrityError) as caught:
        rollback_connection.execute(
            text(
                "INSERT INTO app_private.seller_applications "
                "(id, request_id, buyer_id, seller_id, offer_price, message) "
                "VALUES (:id, :request_id, :buyer_id, :seller_id, :offer_price, '유효한 메시지')"
            ),
            {
                "id": uuid.uuid4(),
                "request_id": parties.request["id"],
                "buyer_id": parties.buyer_user["id"],
                "seller_id": parties.seller_user["id"],
                "offer_price": offer_price,
            },
        )
    assert (
        caught.value.orig.diag.constraint_name
        == "ck_seller_applications_offer_price"
    )


def test_db_constraint_rejects_duplicate_room(
    parties, post_headers, rollback_connection
) -> None:
    created = apply(parties.seller, post_headers, parties.request["id"])
    assert created.status_code == 201, created.text
    application_id = created.json()["application"]["id"]

    with pytest.raises(IntegrityError) as caught:
        rollback_connection.execute(
            text(
                "INSERT INTO app_private.chat_rooms (id, application_id) "
                "VALUES (:id, :application_id)"
            ),
            {"id": uuid.uuid4(), "application_id": application_id},
        )
    assert caught.value.orig.diag.constraint_name == "uq_chat_rooms_application"


def test_fk_cascade_rules_are_declared(db_engine) -> None:
    inspector = inspect(db_engine)
    expected = {
        ("seller_applications", "fk_seller_applications_request_buyer"),
        ("seller_applications", "fk_seller_applications_seller"),
        ("chat_rooms", "fk_chat_rooms_application"),
    }
    seen = set()
    for table_name in ("seller_applications", "chat_rooms"):
        for foreign_key in inspector.get_foreign_keys(table_name, schema="app_private"):
            if (table_name, foreign_key["name"]) in expected:
                assert foreign_key["options"]["ondelete"] == "CASCADE"
                seen.add((table_name, foreign_key["name"]))
    assert seen == expected
    with db_engine.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT conname, confdeltype FROM pg_constraint "
                "WHERE conname = ANY(:names)"
            ),
            {"names": [name for _, name in expected]},
        ).all()
    assert {name: mode for name, mode in rows} == {name: "c" for _, name in expected}


def test_room_insert_pg_failure_rolls_back_application(
    parties, post_headers, db_engine, monkeypatch
) -> None:
    from app.repositories import chat_rooms

    def fail_with_real_fk(db, *args, **kwargs):
        db.execute(
            text(
                "INSERT INTO app_private.chat_rooms (id, application_id) "
                "VALUES (:id, :application_id)"
            ),
            {"id": uuid.uuid4(), "application_id": uuid.uuid4()},
        )

    with monkeypatch.context() as patch:
        patch.setattr(chat_rooms, "create_for_application", fail_with_real_fk)
        response = apply(parties.seller, post_headers, parties.request["id"])
    assert_error(response, 503, "SERVICE_UNAVAILABLE")
    assert owned_counts(db_engine, parties.request["id"]) == (0, 0)
    retry = apply(parties.seller, post_headers, parties.request["id"])
    assert retry.status_code == 201, retry.text


def test_commit_failure_rolls_back_application_and_room(
    parties, post_headers, db_engine, monkeypatch
) -> None:
    def fail_commit(_session) -> None:
        raise OperationalError("COMMIT", {}, RuntimeError("forced commit failure"))

    with monkeypatch.context() as patch:
        patch.setattr(Session, "commit", fail_commit)
        response = apply(parties.seller, post_headers, parties.request["id"])
    assert_error(response, 503, "SERVICE_UNAVAILABLE")
    assert owned_counts(db_engine, parties.request["id"]) == (0, 0)
    assert apply(parties.seller, post_headers, parties.request["id"]).status_code == 201


def test_non_db_exception_after_room_insert_leaves_no_rows(
    parties, post_headers, db_engine, monkeypatch
) -> None:
    from app.repositories import chat_rooms

    original = chat_rooms.create_for_application

    def insert_then_raise(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("forced after room insert")

    with monkeypatch.context() as patch:
        patch.setattr(chat_rooms, "create_for_application", insert_then_raise)
        response = apply(parties.seller, post_headers, parties.request["id"])
    assert_error(response, 500, "INTERNAL_ERROR")
    assert owned_counts(db_engine, parties.request["id"]) == (0, 0)


def test_response_validation_failure_rolls_back_application_and_room(
    parties, post_headers, db_engine, monkeypatch
) -> None:
    from app.repositories import chat_rooms

    original = chat_rooms.create_for_application

    def insert_room_then_return_invalid_metadata(*args, **kwargs):
        room_id, _created_at = original(*args, **kwargs)
        # The real room row now exists in the still-open transaction. Returning
        # an invalid datetime makes ApplyResponse validation fail, which must
        # happen before the service's sole commit.
        return room_id, object()

    with monkeypatch.context() as patch:
        patch.setattr(
            chat_rooms,
            "create_for_application",
            insert_room_then_return_invalid_metadata,
        )
        response = apply(parties.seller, post_headers, parties.request["id"])

    assert_error(response, 500, "INTERNAL_ERROR")
    assert owned_counts(db_engine, parties.request["id"]) == (0, 0)

    retry = apply(parties.seller, post_headers, parties.request["id"])
    assert retry.status_code == 201, retry.text
    assert owned_counts(db_engine, parties.request["id"]) == (1, 1)


def test_schema_objects_and_revision_graph(db_engine) -> None:
    inspector = inspect(db_engine)
    assert inspector.has_table("seller_applications", schema="app_private")
    assert inspector.has_table("chat_rooms", schema="app_private")
    seller_checks = {
        item["name"]
        for item in inspector.get_check_constraints("seller_applications", schema="app_private")
    }
    assert {
        "ck_seller_applications_not_self",
        "ck_seller_applications_offer_price",
        "ck_seller_applications_message_len",
    } <= seller_checks
    seller_indexes = {
        item["name"] for item in inspector.get_indexes("seller_applications", schema="app_private")
    }
    assert {
        "ix_seller_applications_request_created",
        "ix_seller_applications_seller_id",
    } <= seller_indexes
    seller_uniques = {
        item["name"] for item in inspector.get_unique_constraints("seller_applications", schema="app_private")
    }
    room_uniques = {
        item["name"] for item in inspector.get_unique_constraints("chat_rooms", schema="app_private")
    }
    assert "uq_seller_applications_request_seller" in seller_uniques
    assert "uq_chat_rooms_application" in room_uniques
    purchase_uniques = {
        item["name"] for item in inspector.get_unique_constraints("purchase_requests", schema="app_private")
    }
    assert "uq_purchase_requests_id_buyer" in purchase_uniques
    foreign_key_names = {
        item["name"]
        for table_name in ("seller_applications", "chat_rooms")
        for item in inspector.get_foreign_keys(table_name, schema="app_private")
    }
    assert {
        "fk_seller_applications_request_buyer",
        "fk_seller_applications_seller",
        "fk_chat_rooms_application",
    } <= foreign_key_names

    script = ScriptDirectory.from_config(Config(str(ALEMBIC_INI)))
    revisions = list(script.walk_revisions())
    target = script.get_revision("0003_seller_applications")
    assert target is not None
    assert target.down_revision == "0002_create_purchase_requests"
    assert len({revision.revision for revision in revisions}) == len(revisions)
    assert all(len(revision.revision) <= 32 for revision in revisions)


def test_offline_migration_sql_is_additive() -> None:
    upgrade_buffer = io.StringIO()
    upgrade_config = Config(str(ALEMBIC_INI), output_buffer=upgrade_buffer)
    command.upgrade(
        upgrade_config,
        "0002_create_purchase_requests:0003_seller_applications",
        sql=True,
    )
    upgrade_sql = upgrade_buffer.getvalue().upper()
    assert "CREATE TABLE APP_PRIVATE.SELLER_APPLICATIONS" in upgrade_sql
    assert "CREATE TABLE APP_PRIVATE.CHAT_ROOMS" in upgrade_sql
    assert "ADD CONSTRAINT UQ_PURCHASE_REQUESTS_ID_BUYER" in upgrade_sql
    for forbidden in ("DROP ", "TRUNCATE", "DELETE FROM", "ALTER COLUMN", "RENAME"):
        assert forbidden not in upgrade_sql
    assert upgrade_sql.count("ON DELETE CASCADE") >= 3

    downgrade_buffer = io.StringIO()
    downgrade_config = Config(str(ALEMBIC_INI), output_buffer=downgrade_buffer)
    command.downgrade(
        downgrade_config,
        "0003_seller_applications:0002_create_purchase_requests",
        sql=True,
    )
    downgrade_sql = downgrade_buffer.getvalue().upper()
    assert "DROP TABLE APP_PRIVATE.CHAT_ROOMS" in downgrade_sql
    assert "DROP TABLE APP_PRIVATE.SELLER_APPLICATIONS" in downgrade_sql
    assert "DROP TABLE APP_PRIVATE.PURCHASE_REQUESTS" not in downgrade_sql
    assert "DROP TABLE APP_PRIVATE.USERS" not in downgrade_sql
    assert "DROP TABLE APP_PRIVATE.AUTH_SESSIONS" not in downgrade_sql
