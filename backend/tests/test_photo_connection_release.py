"""HTTP-level checks that slow body/storage work runs after releasing DB sessions."""
from __future__ import annotations

from sqlalchemy.exc import SQLAlchemyError

from app.api.deps import get_db, get_photo_storage
from app.db.session import SessionLocal
from app.main import app
from tests.test_private_photo_delivery import PrivateStorage
from tests.test_request_photos import image_bytes, request_payload, signup, upload


def _attach_photo(client, post_headers, storage, email, run_tag):
    app.dependency_overrides[get_photo_storage] = lambda: storage
    signup(client, post_headers, email)
    photo_id = upload(client, image_bytes()).json()["id"]
    created = client.post("/api/requests", headers=post_headers, json=request_payload(run_tag, photoIds=[photo_id]))
    assert created.status_code == 201, created.text
    return photo_id


def test_photo_file_releases_db_before_storage_read(client, post_headers, unique_email, run_tag):
    storage = PrivateStorage()
    photo_id = _attach_photo(client, post_headers, storage, unique_email("connection-read"), run_tag)
    captured = []
    transaction_states = []

    def capture_db():
        db = SessionLocal()
        captured.append(db)
        try:
            yield db
        finally:
            db.close()

    original_read = storage.read
    def inspect_read(path):
        transaction_states.append(captured[-1].in_transaction())
        return original_read(path)
    storage.read = inspect_read
    app.dependency_overrides[get_db] = capture_db
    try:
        response = client.get(f"/api/request-photos/files/{photo_id}.jpg")
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_photo_storage, None)
    assert response.status_code == 200
    assert response.content == next(iter(storage.objects.values()))[0]
    assert transaction_states == [False]


def test_upload_releases_db_before_body_and_normalize(client, post_headers, unique_email, photo_storage, monkeypatch):
    signup(client, post_headers, unique_email("connection-upload"))
    captured = []
    transaction_states = []
    def capture_db():
        db = SessionLocal()
        captured.append(db)
        try:
            yield db
        finally:
            db.close()
    from app.api import request_photos
    original_normalize = request_photos.normalize_image
    def inspect_normalize(data, content_type):
        transaction_states.append(captured[-1].in_transaction())
        return original_normalize(data, content_type)
    monkeypatch.setattr(request_photos, "normalize_image", inspect_normalize)
    app.dependency_overrides[get_db] = capture_db
    try:
        response = upload(client, image_bytes())
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert response.status_code == 201, response.text
    assert transaction_states == [False]
    assert photo_storage.objects


def test_upload_precheck_failure_still_503_and_limit_409(client, post_headers, unique_email, photo_storage, monkeypatch):
    signup(client, post_headers, unique_email("connection-precheck"))
    from app.api import request_photos

    monkeypatch.setattr(request_photos, "active_upload_count", lambda *_: 10)
    limited = upload(client, image_bytes())
    assert limited.status_code == 409
    assert limited.json()["error"]["code"] == "PHOTO_LIMIT_EXCEEDED"

    def fail_precheck(*_args):
        raise SQLAlchemyError("injected precheck failure")
    monkeypatch.setattr(request_photos, "active_upload_count", fail_precheck)
    unavailable = upload(client, image_bytes())
    assert unavailable.status_code == 503
    assert unavailable.json()["error"]["code"] == "SERVICE_UNAVAILABLE"
