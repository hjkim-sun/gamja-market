from __future__ import annotations

import importlib
import io
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError


PHOTO_PATH = "/api/request-photos"
REQUEST_PATH = "/api/requests"
MAX_BYTES = 3 * 1024 * 1024


def signup(client: TestClient, headers: dict[str, str], email: str) -> None:
    response = client.post(
        "/api/auth/signup",
        headers=headers,
        json={
            "email": email,
            "password": "potato-pass-123",
            "password_confirmation": "potato-pass-123",
        },
    )
    assert response.status_code == 201, response.text


def request_payload(run_tag: str, **overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "title": f"{run_tag} 사진 구매요청",
        "category": "디지털기기",
        "description": "사진 계약을 검증하기 위한 충분히 긴 구매요청 설명입니다.",
        "priceMin": 100_000,
        "priceMax": 200_000,
        "condition": "like_new",
        "region": "서울 강남구",
    }
    payload.update(overrides)
    return payload


def image_bytes(
    image_format: str = "JPEG",
    *,
    size: tuple[int, int] = (8, 6),
    animated: bool = False,
    metadata: bool = False,
) -> bytes:
    mode = "RGBA" if image_format in {"PNG", "WEBP"} else "RGB"
    image = Image.new(mode, size, (210, 130, 40, 120) if mode == "RGBA" else (210, 130, 40))
    output = io.BytesIO()
    save_kwargs: dict[str, object] = {}
    if image_format == "JPEG" and metadata:
        exif = Image.Exif()
        exif[274] = 6
        exif[270] = "private-location-like-metadata"
        save_kwargs["exif"] = exif
    if image_format == "PNG" and metadata:
        pnginfo = PngImagePlugin.PngInfo()
        pnginfo.add_text("Location", "private-location-like-metadata")
        save_kwargs["pnginfo"] = pnginfo
    if animated:
        second = Image.new(mode, size, (10, 20, 30, 255) if mode == "RGBA" else (10, 20, 30))
        image.save(
            output,
            format=image_format,
            save_all=True,
            append_images=[second],
            duration=100,
            loop=0,
            **save_kwargs,
        )
    else:
        image.save(output, format=image_format, **save_kwargs)
    return output.getvalue()


def upload(
    client: TestClient,
    data: bytes,
    content_type: str = "image/jpeg",
) -> object:
    return client.post(
        PHOTO_PATH,
        headers={
            "Origin": "http://localhost:3000",
            "X-Requested-With": "gamja-market",
            "Content-Type": content_type,
        },
        content=data,
    )


def database_engine():
    from app.core.config import get_settings

    return create_engine(get_settings().database_url)


class _SecondCommitFailure:
    """Delegate a real Session while making only the pending commit ambiguous."""

    def __init__(self, session, *, commit_then_raise: bool) -> None:
        self._session = session
        self._commit_then_raise = commit_then_raise
        self._commits = 0

    def commit(self) -> None:
        self._commits += 1
        if self._commits == 2:
            if self._commit_then_raise:
                self._session.commit()
            raise SQLAlchemyError("injected pending commit ambiguity")
        self._session.commit()

    def __getattr__(self, name: str):
        return getattr(self._session, name)


class _CommitFailure:
    def __init__(self, session) -> None:
        self._session = session

    def commit(self) -> None:
        raise SQLAlchemyError("injected durable commit failure")

    def __getattr__(self, name: str):
        return getattr(self._session, name)


def _session():
    from app.db.session import create_session_factory

    return create_session_factory()()


def _user_id(email: str):
    engine = database_engine()
    with engine.connect() as connection:
        user_id = connection.scalar(text("SELECT id FROM app_private.users WHERE email = :email"), {"email": email})
    engine.dispose()
    return user_id


def _photo_state(photo_id: str):
    engine = database_engine()
    with engine.connect() as connection:
        row = connection.execute(text(
            "SELECT status, storage_path, object_deleted_at FROM app_private.purchase_request_photos WHERE id = :id"
        ), {"id": photo_id}).mappings().one()
    engine.dispose()
    return row


@pytest.mark.parametrize(
    ("image_format", "content_type", "expected_ext"),
    [
        ("JPEG", "image/jpeg", "jpg"),
        ("PNG", "image/png", "png"),
        ("WEBP", "image/webp", "webp"),
    ],
)
def test_normalize_real_images_preserves_format_and_strips_metadata(
    image_format, content_type, expected_ext
) -> None:
    """Internal contract: normalize_image(bytes, declared_type) -> NormalizedImage."""
    module = importlib.import_module("app.services.photo_validation")
    normalized = module.normalize_image(
        image_bytes(image_format, metadata=image_format != "WEBP"),
        content_type,
    )
    assert normalized.content_type == content_type
    assert normalized.ext == expected_ext
    assert (normalized.width, normalized.height) == ((6, 8) if image_format == "JPEG" else (8, 6))
    decoded = Image.open(io.BytesIO(normalized.data))
    decoded.load()
    assert decoded.format == image_format
    assert not decoded.getexif()
    assert "Location" not in decoded.info
    assert "private-location-like-metadata" not in repr(decoded.info)


@pytest.mark.parametrize(
    ("data", "declared_type"),
    [
        (b"", "image/jpeg"),
        (b"\xff\xd8\xffnot-a-real-jpeg", "image/jpeg"),
        (b"<html>not an image</html>", "image/png"),
        (image_bytes("PNG"), "image/jpeg"),
        (image_bytes("WEBP", animated=True), "image/webp"),
    ],
)
def test_normalize_rejects_invalid_mismatched_or_animated_images(data, declared_type) -> None:
    module = importlib.import_module("app.services.photo_validation")
    with pytest.raises(module.InvalidImage):
        module.normalize_image(data, declared_type)


def test_normalize_palette_png_keeps_transparency_while_scrubbing_metadata() -> None:
    image = Image.new("P", (2, 1))
    image.putpalette([255, 0, 0, 0, 255, 0] + [0] * 762)
    image.putdata([0, 1])
    output = io.BytesIO()
    info = PngImagePlugin.PngInfo()
    info.add_text("Location", "private-location-like-metadata")
    image.save(output, format="PNG", transparency=0, pnginfo=info)

    from app.services.photo_validation import normalize_image

    normalized = normalize_image(output.getvalue(), "image/png")
    decoded = Image.open(io.BytesIO(normalized.data)).convert("RGBA")
    assert decoded.getpixel((0, 0))[3] == 0
    assert decoded.getpixel((1, 0))[3] == 255
    assert "Location" not in Image.open(io.BytesIO(normalized.data)).info


def test_upload_authentication_precedes_storage_and_media_validation(client) -> None:
    response = client.post(
        PHOTO_PATH,
        headers={
            "Origin": "http://localhost:3000",
            "X-Requested-With": "gamja-market",
            "Content-Type": "application/json",
        },
        content=b"not-an-image",
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHENTICATED"
    assert response.headers["cache-control"] == "no-store"


def test_upload_requires_same_origin_headers(client, post_headers, unique_email) -> None:
    signup(client, post_headers, unique_email())
    response = client.post(
        PHOTO_PATH,
        headers={"Content-Type": "image/jpeg"},
        content=image_bytes(),
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "INVALID_ORIGIN"


@pytest.mark.parametrize("content_type", ["image/gif", "image/svg+xml", "application/json", "multipart/form-data"])
def test_upload_rejects_unsupported_media_types(
    client, post_headers, unique_email, photo_storage, content_type
) -> None:
    signup(client, post_headers, unique_email())
    response = upload(client, image_bytes(), content_type)
    assert response.status_code == 415
    assert response.json()["error"]["code"] == "UNSUPPORTED_MEDIA_TYPE"
    assert photo_storage.calls == []


def test_upload_rejects_declared_format_mismatch_and_oversize(
    client, post_headers, unique_email, photo_storage
) -> None:
    signup(client, post_headers, unique_email())
    mismatch = upload(client, image_bytes("PNG"), "image/jpeg")
    too_large = upload(client, b"x" * (MAX_BYTES + 1), "image/png")
    assert mismatch.status_code == 422
    assert mismatch.json()["error"]["code"] == "INVALID_IMAGE"
    assert too_large.status_code == 413
    assert too_large.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"
    assert photo_storage.calls == []


@pytest.mark.parametrize(
    ("image_format", "content_type", "extension"),
    [("JPEG", "image/jpeg", ".jpg"), ("PNG", "image/png", ".png"), ("WEBP", "image/webp", ".webp")],
)
def test_upload_stores_only_normalized_bytes_and_returns_no_url_or_path(
    client, post_headers, unique_email, photo_storage, image_format, content_type, extension
) -> None:
    signup(client, post_headers, unique_email())
    original = image_bytes(image_format, metadata=image_format != "WEBP")
    response = upload(client, original, content_type)
    assert response.status_code == 201, response.text
    assert set(response.json()) == {"id", "contentType", "byteSize", "width", "height", "expiresAt"}
    photo_id = response.json()["id"]
    uuid.UUID(photo_id)
    path = next(iter(photo_storage.objects))
    stored, stored_type = photo_storage.objects[path]
    assert path == f"photos/{photo_id}{extension}"
    assert stored_type == content_type
    assert response.json()["byteSize"] == len(stored)
    assert stored != original or image_format == "WEBP"
    assert not Image.open(io.BytesIO(stored)).getexif()

    engine = database_engine()
    with engine.connect() as connection:
        row = connection.execute(
            text(
                "SELECT status, storage_backend, storage_bucket, storage_path, byte_size "
                "FROM app_private.purchase_request_photos WHERE id = :id"
            ),
            {"id": photo_id},
        ).mappings().one()
    engine.dispose()
    assert row["status"] == "pending"
    assert row["storage_backend"] == "memory"
    assert row["storage_bucket"] is None
    assert row["storage_path"] == path
    assert row["byte_size"] == len(stored)


def test_same_user_concurrent_upload_limit_is_serialized(
    client, post_headers, unique_email, photo_storage
) -> None:
    signup(client, post_headers, unique_email("limit"))
    jpeg = image_bytes()
    for _ in range(9):
        assert upload(client, jpeg).status_code == 201

    cookie = client.cookies.get("gamja_session")
    barrier = threading.Barrier(2)

    def competing_upload() -> int:
        from app.main import app

        with TestClient(app, raise_server_exceptions=False) as concurrent_client:
            concurrent_client.cookies.set("gamja_session", cookie)
            barrier.wait(timeout=5)
            return upload(concurrent_client, jpeg).status_code

    photo_storage.put_delay = 0.05
    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = sorted(pool.map(lambda _: competing_upload(), range(2)))
    assert statuses == [201, 409]


def test_storage_failure_discards_intent_and_never_leaks_exception(
    client, post_headers, unique_email, photo_storage
) -> None:
    signup(client, post_headers, unique_email("failure"))
    photo_storage.fail_put = True
    response = upload(client, image_bytes())
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "PHOTO_STORAGE_UNAVAILABLE"
    assert "injected storage failure" not in response.text
    put_path = next(value for action, value in photo_storage.calls if action == "put")
    delete_index = next(i for i, call in enumerate(photo_storage.calls) if call[0] == "delete_many")
    put_index = next(i for i, call in enumerate(photo_storage.calls) if call[0] == "put")
    assert put_index < delete_index

    engine = database_engine()
    with engine.connect() as connection:
        row = connection.execute(
            text(
                "SELECT status, discarded_at, object_deleted_at "
                "FROM app_private.purchase_request_photos WHERE storage_path = :path"
            ),
            {"path": put_path},
        ).mappings().one()
    engine.dispose()
    assert row["status"] == "discarded"
    assert row["discarded_at"] is not None
    assert row["object_deleted_at"] is None


def test_create_without_photo_ids_remains_backward_compatible(
    client, post_headers, run_tag, unique_email
) -> None:
    signup(client, post_headers, unique_email("legacy"))
    response = client.post(REQUEST_PATH, headers=post_headers, json=request_payload(run_tag))
    assert response.status_code == 201
    assert response.json()["photos"] == []
    assert response.json()["thumbnailUrl"] is None


@pytest.mark.parametrize(
    "photo_ids",
    [
        [str(uuid.uuid4())] * 2,
        [str(uuid.uuid4()) for _ in range(6)],
        ["not-a-uuid"],
        "not-an-array",
    ],
)
def test_create_validates_photo_id_shape(
    client, post_headers, run_tag, unique_email, photo_ids
) -> None:
    signup(client, post_headers, unique_email("shape"))
    response = client.post(
        REQUEST_PATH,
        headers=post_headers,
        json=request_payload(run_tag, photoIds=photo_ids),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert "photoIds" in response.json()["error"]["fields"]


def test_photo_ids_are_owner_scoped_for_attach_and_delete(
    client, post_headers, run_tag, unique_email, photo_storage
) -> None:
    signup(client, post_headers, unique_email("owner"))
    photo_id = upload(client, image_bytes()).json()["id"]

    client.cookies.clear()
    signup(client, post_headers, unique_email("attacker"))
    attach = client.post(
        REQUEST_PATH,
        headers=post_headers,
        json=request_payload(run_tag, photoIds=[photo_id]),
    )
    discard = client.delete(
        f"{PHOTO_PATH}/{photo_id}",
        headers={
            "Origin": "http://localhost:3000",
            "X-Requested-With": "gamja-market",
        },
    )
    assert attach.status_code == 422
    assert attach.json()["error"]["fields"]["photoIds"]
    assert discard.status_code == 404

    engine = database_engine()
    with engine.connect() as connection:
        assert connection.scalar(
            text("SELECT count(*) FROM app_private.purchase_requests WHERE title = :title"),
            {"title": request_payload(run_tag)["title"]},
        ) == 0
        assert connection.scalar(
            text("SELECT status FROM app_private.purchase_request_photos WHERE id = :id"),
            {"id": photo_id},
        ) == "pending"
    engine.dispose()


def test_attached_photos_follow_payload_order_and_legacy_column_stays_null(
    client, post_headers, run_tag, unique_email, photo_storage
) -> None:
    signup(client, post_headers, unique_email("attach"))
    uploaded = [upload(client, image_bytes()).json()["id"] for _ in range(3)]
    requested_order = [uploaded[2], uploaded[0], uploaded[1]]
    response = client.post(
        REQUEST_PATH,
        headers=post_headers,
        json=request_payload(run_tag, photoIds=requested_order),
    )
    assert response.status_code == 201, response.text
    assert [photo["id"] for photo in response.json()["photos"]] == requested_order
    assert response.json()["thumbnailUrl"] == response.json()["photos"][0]["url"]

    engine = database_engine()
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT id::text, status, sort_order FROM app_private.purchase_request_photos "
                "WHERE id = ANY(CAST(:ids AS uuid[])) ORDER BY sort_order"
            ),
            {"ids": requested_order},
        ).all()
        thumbnail = connection.scalar(
            text("SELECT thumbnail_url FROM app_private.purchase_requests WHERE id = :id"),
            {"id": response.json()["id"]},
        )
    engine.dispose()
    assert [row[0] for row in rows] == requested_order
    assert all(row[1] == "attached" for row in rows)
    assert [row[2] for row in rows] == [0, 1, 2]
    assert thumbnail is None


def test_additive_migration_contract_exists_and_does_not_touch_version_state() -> None:
    migration = Path(__file__).parents[1] / "migrations" / "versions" / "0004_create_purchase_request_photos.py"
    assert migration.exists(), "backend must provide the approved additive 0004 migration"
    from tests.support.schema import ensure_additive_schema

    engine = database_engine()
    with engine.connect() as connection:
        before = connection.execute(text("SELECT version_num FROM alembic_version ORDER BY version_num")).scalars().all()
    ensure_additive_schema(engine)
    ensure_additive_schema(engine)
    with engine.connect() as connection:
        after = connection.execute(text("SELECT version_num FROM alembic_version ORDER BY version_num")).scalars().all()
    engine.dispose()
    assert after == before


def test_sweep_is_dry_by_default_then_deletes_only_owned_expired_photo(
    client, post_headers, unique_email, photo_storage
) -> None:
    """Cleanup is explicitly scoped and does not remove a pending object first."""
    signup(client, post_headers, unique_email("sweep"))
    photo_id = upload(client, image_bytes()).json()["id"]
    engine = database_engine()
    with engine.begin() as connection:
        row = connection.execute(text(
            "SELECT uploader_id, storage_path FROM app_private.purchase_request_photos WHERE id = :id"
        ), {"id": photo_id}).mappings().one()
        connection.execute(text(
            "UPDATE app_private.purchase_request_photos SET created_at = :past WHERE id = :id"
        ), {"past": datetime.now(timezone.utc) - timedelta(hours=26), "id": photo_id})
    engine.dispose()

    from app.db.session import create_session_factory
    from app.services.request_photos import sweep_request_photos

    db = create_session_factory()()
    try:
        dry = sweep_request_photos(db, photo_storage, photo_storage.namespace, now=datetime.now(timezone.utc), limit=10, dry_run=True, uploader_id=row["uploader_id"])
        assert dry == {"candidates": 1, "deleted": 0, "skipped": 0}
        assert row["storage_path"] in photo_storage.objects
        applied = sweep_request_photos(db, photo_storage, photo_storage.namespace, now=datetime.now(timezone.utc), limit=10, dry_run=False, uploader_id=row["uploader_id"])
        assert applied["deleted"] == 1
    finally:
        db.close()
    assert row["storage_path"] not in photo_storage.objects
    engine = database_engine()
    with engine.connect() as connection:
        state = connection.execute(text(
            "SELECT status, object_deleted_at FROM app_private.purchase_request_photos WHERE id = :id"
        ), {"id": photo_id}).mappings().one()
    engine.dispose()
    assert state["status"] == "discarded"
    assert state["object_deleted_at"] is not None


def test_ambiguous_pending_commit_that_durably_succeeds_preserves_pending_object(
    client, post_headers, unique_email, photo_storage
) -> None:
    email = unique_email("commit-after")
    signup(client, post_headers, email)
    from app.services.photo_validation import normalize_image
    from app.services.request_photos import upload_normalized

    real_db = _session()
    try:
        result = upload_normalized(
            _SecondCommitFailure(real_db, commit_then_raise=True),
            uploader_id=_user_id(email), image=normalize_image(image_bytes(), "image/jpeg"), storage=photo_storage,
            fresh_session_factory=_session,
        )
    finally:
        real_db.close()
    state = _photo_state(str(result.id))
    assert state["status"] == "pending"
    assert state["storage_path"] in photo_storage.objects
    assert not [call for call in photo_storage.calls if call[0] == "delete_many"]


def test_unapplied_pending_commit_discards_durably_before_deleting_object(
    client, post_headers, unique_email, photo_storage
) -> None:
    email = unique_email("commit-before")
    signup(client, post_headers, email)
    from app.services.photo_validation import normalize_image
    from app.services.request_photos import ServiceUnavailable, upload_normalized

    real_db = _session()
    try:
        with pytest.raises(ServiceUnavailable):
            upload_normalized(
                _SecondCommitFailure(real_db, commit_then_raise=False),
                uploader_id=_user_id(email), image=normalize_image(image_bytes(), "image/jpeg"), storage=photo_storage,
                fresh_session_factory=_session,
            )
    finally:
        real_db.close()
    put_path = next(value for action, value in photo_storage.calls if action == "put")
    state = _photo_state(_photo_id_from_path(put_path))
    assert state["status"] == "discarded"
    assert state["object_deleted_at"] is not None
    assert put_path not in photo_storage.objects


def _photo_id_from_path(path: str) -> str:
    return path.removeprefix("photos/").rsplit(".", 1)[0]


def test_ambiguous_commit_with_failed_fresh_reread_never_deletes(
    client, post_headers, unique_email, photo_storage
) -> None:
    email = unique_email("reread-failure")
    signup(client, post_headers, email)
    from app.services.photo_validation import normalize_image
    from app.services.request_photos import ServiceUnavailable, upload_normalized

    real_db = _session()
    try:
        with pytest.raises(ServiceUnavailable):
            upload_normalized(
                _SecondCommitFailure(real_db, commit_then_raise=False),
                uploader_id=_user_id(email), image=normalize_image(image_bytes(), "image/jpeg"), storage=photo_storage,
                fresh_session_factory=lambda: (_ for _ in ()).throw(RuntimeError("reread unavailable")),
            )
    finally:
        real_db.close()
    put_path = next(value for action, value in photo_storage.calls if action == "put")
    assert put_path in photo_storage.objects
    assert not [call for call in photo_storage.calls if call[0] == "delete_many"]
    assert _photo_state(_photo_id_from_path(put_path))["status"] == "uploading"


def test_discard_and_sweep_commit_failures_never_delete_objects(
    client, post_headers, unique_email, photo_storage
) -> None:
    email = unique_email("commit-failures")
    signup(client, post_headers, email)
    photo_id = upload(client, image_bytes()).json()["id"]
    state = _photo_state(photo_id)
    from app.services.request_photos import ServiceUnavailable, discard_pending, sweep_request_photos

    db = _session()
    try:
        with pytest.raises(ServiceUnavailable):
            discard_pending(_CommitFailure(db), photo_id=uuid.UUID(photo_id), uploader_id=_user_id(email), namespace=photo_storage.namespace, storage=photo_storage)
    finally:
        db.close()
    assert state["storage_path"] in photo_storage.objects
    assert not [call for call in photo_storage.calls if call[0] == "delete_many"]

    engine = database_engine()
    with engine.begin() as connection:
        connection.execute(text("UPDATE app_private.purchase_request_photos SET created_at = :past WHERE id = :id"), {"past": datetime.now(timezone.utc) - timedelta(hours=26), "id": photo_id})
    engine.dispose()
    db = _session()
    try:
        result = sweep_request_photos(_CommitFailure(db), photo_storage, photo_storage.namespace, now=datetime.now(timezone.utc), limit=10, dry_run=False, uploader_id=_user_id(email))
    finally:
        db.close()
    assert result["deleted"] == 0
    assert state["storage_path"] in photo_storage.objects
    assert not [call for call in photo_storage.calls if call[0] == "delete_many"]


def test_failed_storage_delete_leaves_discarded_photo_retryable(
    client, post_headers, unique_email, photo_storage
) -> None:
    email = unique_email("delete-failure")
    signup(client, post_headers, email)
    photo_id = upload(client, image_bytes()).json()["id"]
    photo_storage.fail_delete = True
    response = client.delete(f"{PHOTO_PATH}/{photo_id}", headers={"Origin": "http://localhost:3000", "X-Requested-With": "gamja-market"})
    assert response.status_code == 204
    state = _photo_state(photo_id)
    assert state["status"] == "discarded"
    assert state["object_deleted_at"] is None
    assert state["storage_path"] in photo_storage.objects


def test_upload_service_unavailable_is_sanitized_at_api_boundary(
    client, post_headers, unique_email, photo_storage, monkeypatch
) -> None:
    signup(client, post_headers, unique_email("api-unavailable"))
    from app.services.errors import ServiceUnavailable

    def fail_upload(*_: object, **__: object):
        raise ServiceUnavailable

    monkeypatch.setattr("app.api.request_photos.upload_normalized", fail_upload)
    response = upload(client, image_bytes())
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "SERVICE_UNAVAILABLE"
    assert "unavailable" not in response.json()["error"]["message"].lower()


def test_attach_rejects_expired_discarded_attached_and_foreign_namespace_photos(
    client, post_headers, run_tag, unique_email, photo_storage
) -> None:
    signup(client, post_headers, unique_email("attach-states"))

    expired = upload(client, image_bytes()).json()["id"]
    engine = database_engine()
    with engine.begin() as connection:
        connection.execute(text("UPDATE app_private.purchase_request_photos SET created_at = :past WHERE id = :id"), {"past": datetime.now(timezone.utc) - timedelta(hours=25), "id": expired})
    engine.dispose()
    expired_response = client.post(REQUEST_PATH, headers=post_headers, json=request_payload(run_tag, title=f"{run_tag} expired", photoIds=[expired]))
    assert expired_response.status_code == 422
    assert expired_response.json()["error"]["fields"]["photoIds"]

    discarded = upload(client, image_bytes()).json()["id"]
    assert client.delete(f"{PHOTO_PATH}/{discarded}", headers={"Origin": "http://localhost:3000", "X-Requested-With": "gamja-market"}).status_code == 204
    assert client.post(REQUEST_PATH, headers=post_headers, json=request_payload(run_tag, title=f"{run_tag} discarded", photoIds=[discarded])).status_code == 422

    foreign_namespace = upload(client, image_bytes()).json()["id"]
    engine = database_engine()
    with engine.begin() as connection:
        connection.execute(text("UPDATE app_private.purchase_request_photos SET storage_backend = 'local' WHERE id = :id"), {"id": foreign_namespace})
    engine.dispose()
    assert client.post(REQUEST_PATH, headers=post_headers, json=request_payload(run_tag, title=f"{run_tag} namespace", photoIds=[foreign_namespace])).status_code == 422

    attached = upload(client, image_bytes()).json()["id"]
    first = client.post(REQUEST_PATH, headers=post_headers, json=request_payload(run_tag, title=f"{run_tag} attached", photoIds=[attached]))
    assert first.status_code == 201
    assert client.delete(f"{PHOTO_PATH}/{attached}", headers={"Origin": "http://localhost:3000", "X-Requested-With": "gamja-market"}).status_code == 404
    assert client.post(REQUEST_PATH, headers=post_headers, json=request_payload(run_tag, title=f"{run_tag} reused", photoIds=[attached])).status_code == 422


def test_concurrent_attach_of_same_photo_has_one_winner_and_no_partial_request(
    client, post_headers, run_tag, unique_email, photo_storage
) -> None:
    signup(client, post_headers, unique_email("attach-race"))
    photo_id = upload(client, image_bytes()).json()["id"]
    cookie = client.cookies.get("gamja_session")
    barrier = threading.Barrier(2)

    def attach(index: int) -> int:
        from app.main import app

        with TestClient(app, raise_server_exceptions=False) as concurrent_client:
            concurrent_client.cookies.set("gamja_session", cookie)
            barrier.wait(timeout=5)
            return concurrent_client.post(
                REQUEST_PATH, headers=post_headers,
                json=request_payload(run_tag, title=f"{run_tag} attach-race-{index}", photoIds=[photo_id]),
            ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = sorted(pool.map(attach, range(2)))
    assert statuses == [201, 422]
    engine = database_engine()
    with engine.connect() as connection:
        attached_count = connection.scalar(text("SELECT count(*) FROM app_private.purchase_request_photos WHERE id = :id AND status = 'attached'"), {"id": photo_id})
        request_count = connection.scalar(text("SELECT count(*) FROM app_private.purchase_requests WHERE title LIKE :title"), {"title": f"{run_tag} attach-race-%"})
    engine.dispose()
    assert attached_count == 1
    assert request_count == 1
