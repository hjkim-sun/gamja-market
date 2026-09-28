from __future__ import annotations

import uuid

from sqlalchemy import text

from app.api.deps import get_photo_storage
from app.main import app
from app.storage.base import StorageError
from app.storage.local import LocalPhotoStorage
from tests.support.fake_storage import FakePhotoStorage
from tests.test_request_photos import image_bytes, request_payload, signup, upload


class PrivateStorage(FakePhotoStorage):
    @property
    def namespace(self) -> tuple[str, str]:
        return ("supabase", "private-photos")

    def read(self, path: str) -> bytes:
        self.calls.append(("read", path))
        return self.objects[path][0]


def test_private_bucket_attached_photo_is_served_via_public_api_only(
    client, post_headers, run_tag, unique_email
) -> None:
    storage = PrivateStorage()
    app.dependency_overrides[get_photo_storage] = lambda: storage
    try:
        signup(client, post_headers, unique_email("private"))
        photo_id = upload(client, image_bytes()).json()["id"]
        photo_url = f"/api/request-photos/files/{photo_id}.jpg"
        assert client.get(photo_url).status_code == 404
        created = client.post("/api/requests", headers=post_headers, json=request_payload(run_tag, photoIds=[photo_id]))
        assert created.status_code == 201, created.text
        assert created.json()["photos"] == [{"id": photo_id, "url": photo_url}]
        request_id = created.json()["id"]
        client.cookies.clear()
        detail = client.get(f"/api/requests/{request_id}")
        assert detail.json()["thumbnailUrl"] == photo_url
        assert detail.json()["photos"][0]["url"] == photo_url
        listed = client.get("/api/requests", params={"q": run_tag})
        assert listed.json()["items"][0]["thumbnailUrl"] == photo_url
        fetched = client.get(photo_url)
        assert fetched.status_code == 200
        assert fetched.content == next(iter(storage.objects.values()))[0]
        assert fetched.headers["content-type"].startswith("image/jpeg")
        assert fetched.headers["cache-control"] == "public, max-age=3600"
        assert fetched.headers["x-content-type-options"] == "nosniff"
        assert client.get(photo_url.replace(".jpg", ".png")).status_code == 404

        def unavailable(_: str) -> bytes:
            raise StorageError("upstream failed")

        original_read = storage.read
        storage.read = unavailable  # type: ignore[method-assign]
        failed = client.get(photo_url)
        assert failed.status_code == 503
        assert failed.json()["error"]["code"] == "PHOTO_STORAGE_UNAVAILABLE"
        assert failed.headers["cache-control"] == "no-store"
        storage.read = original_read  # type: ignore[method-assign]

        from tests.test_request_photos import database_engine
        engine = database_engine()
        with engine.begin() as connection:
            connection.execute(text("UPDATE app_private.purchase_request_photos SET storage_bucket = 'other-private-bucket' WHERE id = :id"), {"id": str(uuid.UUID(photo_id))})
        engine.dispose()
        assert client.get(photo_url).status_code == 404
    finally:
        app.dependency_overrides.pop(get_photo_storage, None)


def test_local_driver_keeps_attached_file_delivery(client, post_headers, run_tag, unique_email, tmp_path) -> None:
    storage = LocalPhotoStorage(str(tmp_path))
    app.dependency_overrides[get_photo_storage] = lambda: storage
    try:
        signup(client, post_headers, unique_email("local-photo"))
        photo_id = upload(client, image_bytes()).json()["id"]
        url = f"/api/request-photos/files/{photo_id}.jpg"
        assert client.get(url).status_code == 404
        created = client.post("/api/requests", headers=post_headers, json=request_payload(run_tag, photoIds=[photo_id]))
        assert created.status_code == 201
        assert created.json()["photos"][0]["url"] == url
        assert client.get(url).status_code == 200
    finally:
        app.dependency_overrides.pop(get_photo_storage, None)
