"""Behavioral assertions for P-02/P-06/P-07 request and photo contracts."""
from __future__ import annotations

import io
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from PIL import Image
from sqlalchemy import event, text

from tests.test_request_photos import image_bytes, request_payload, signup, upload


def _image(width: int, height: int, fmt: str, *, exif_orientation: int | None = None) -> bytes:
    output = io.BytesIO()
    image = Image.new("RGB", (width, height), (30, 90, 140))
    options = {}
    if exif_orientation is not None:
        exif = Image.Exif()
        exif[274] = exif_orientation
        options["exif"] = exif
    image.save(output, fmt, **options)
    return output.getvalue()


@pytest.mark.parametrize("fmt,content_type,size,expected", [
    ("JPEG", "image/jpeg", (4000, 3000), (1600, 1200)),
    ("PNG", "image/png", (3000, 4000), (1200, 1600)),
    ("WEBP", "image/webp", (4000, 3000), (1600, 1200)),
])
def test_normalize_downscales_long_edge(fmt, content_type, size, expected):
    from app.services.photo_validation import normalize_image
    result = normalize_image(_image(*size, fmt), content_type)
    assert (result.width, result.height) == expected
    assert result.content_type == content_type
    with Image.open(io.BytesIO(result.data)) as normalized:
        assert normalized.format == fmt
        assert normalized.size == expected
        assert not normalized.getexif()
        assert "Location" not in normalized.info
        assert all("private" not in str(value) for value in normalized.info.values())


def test_normalize_keeps_small_images_and_exif_rotation():
    from app.services.photo_validation import normalize_image
    small = normalize_image(_image(1200, 800, "JPEG"), "image/jpeg")
    rotated = normalize_image(_image(4000, 3000, "JPEG", exif_orientation=6), "image/jpeg")
    assert (small.width, small.height) == (1200, 800)
    assert (rotated.width, rotated.height) == (1200, 1600)
    with Image.open(io.BytesIO(rotated.data)) as output:
        assert 274 not in output.getexif()


def test_normalize_concurrency_is_bounded(monkeypatch):
    from app.services import photo_validation

    active = 0
    maximum = 0
    lock = threading.Lock()
    original_encode = photo_validation._encode

    def slow_encode(image, image_format):
        nonlocal active, maximum
        with lock:
            active += 1
            maximum = max(maximum, active)
        try:
            time.sleep(0.04)
            return original_encode(image, image_format)
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(photo_validation, "_encode", slow_encode)
    data = _image(800, 600, "JPEG")
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: photo_validation.normalize_image(data, "image/jpeg"), range(4)))
    assert len(results) == 4
    assert maximum <= photo_validation.NORMALIZE_CONCURRENCY == 2


def test_normalize_rejects_before_acquiring_slot(monkeypatch):
    from app.services import photo_validation

    acquired = []
    class NeverAcquire:
        def acquire(self):
            acquired.append(True)
            raise AssertionError("invalid image attempted to acquire a normalization slot")
        def release(self):
            pass

    monkeypatch.setattr(photo_validation, "_normalize_slots", NeverAcquire())
    with pytest.raises(photo_validation.InvalidImage):
        photo_validation.normalize_image(b"not-an-image", "image/jpeg")
    assert acquired == []


def test_normalization_slot_wait_is_bounded_and_releases_no_slot_leak(
    client, post_headers, unique_email, photo_storage, monkeypatch
):
    from app.core.config import get_settings
    from app.main import app
    from app.services import photo_validation
    from tests.test_request_photos import signup, upload, image_bytes

    settings = get_settings().model_copy(update={"image_normalize_wait_seconds": 0.02})
    assert settings.image_normalize_wait_seconds == 0.02
    app.dependency_overrides[get_settings] = lambda: settings
    held_slots = []
    try:
        signup(client, post_headers, unique_email("normalization-wait"))
        held_slots = [
            photo_validation._normalize_slots.acquire(blocking=False)
            for _ in range(photo_validation.NORMALIZE_CONCURRENCY)
        ]
        assert all(held_slots)
        response = upload(client, image_bytes())
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "SERVICE_UNAVAILABLE"
    finally:
        app.dependency_overrides.pop(get_settings, None)
        for acquired in reversed(held_slots):
            if acquired:
                photo_validation._normalize_slots.release()

    # A timed-out attempt must not release a slot owned by another request or
    # retain a slot after it returns.
    reacquired = [
        photo_validation._normalize_slots.acquire(blocking=False)
        for _ in range(photo_validation.NORMALIZE_CONCURRENCY)
    ]
    try:
        assert all(reacquired)
    finally:
        for acquired in reversed(reacquired):
            if acquired:
                photo_validation._normalize_slots.release()


def test_upload_response_reports_downscaled_dimensions(client, post_headers, unique_email, photo_storage, db_engine):
    signup(client, post_headers, unique_email("downscale"))
    response = upload(client, image_bytes(size=(4000, 3000)))
    assert response.status_code == 201, response.text
    body = response.json()
    assert (body["width"], body["height"]) == (1600, 1200)
    with db_engine.connect() as connection:
        row = connection.execute(text("""
            SELECT width, height, byte_size, storage_path
            FROM app_private.purchase_request_photos WHERE id = :id
        """), {"id": body["id"]}).mappings().one()
    assert (row["width"], row["height"]) == (body["width"], body["height"])
    stored = photo_storage.objects[row["storage_path"]][0]
    with Image.open(io.BytesIO(stored)) as image:
        assert image.size == (body["width"], body["height"])
    assert len(stored) == row["byte_size"]


def test_photo_file_cache_headers(client, post_headers, unique_email, run_tag, db_engine):
    from app.api.deps import get_photo_storage
    from app.main import app
    from tests.support.fake_storage import FakePhotoStorage

    class DeliveryStorage(FakePhotoStorage):
        @property
        def namespace(self):
            return ("supabase", "red-test-private")
        def read(self, path: str) -> bytes:
            return self.objects[path][0]

    storage = DeliveryStorage()
    app.dependency_overrides[get_photo_storage] = lambda: storage
    try:
        signup(client, post_headers, unique_email("cache"))
        photo_id = upload(client, image_bytes()).json()["id"]
        created = client.post("/api/requests", headers=post_headers, json=request_payload(run_tag, photoIds=[photo_id]))
        assert created.status_code == 201, created.text
        url = f"/api/request-photos/files/{photo_id}.jpg"
        client.cookies.clear()
        response = client.get(url)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "public, max-age=86400, immutable"
        assert response.headers["vercel-cdn-cache-control"] == "max-age=604800"
        assert response.headers["x-content-type-options"] == "nosniff"

        missing = client.get("/api/request-photos/files/00000000-0000-4000-8000-000000000099.jpg")
        assert missing.status_code == 404
        assert missing.headers["cache-control"] == "no-store"
        assert "vercel-cdn-cache-control" not in missing.headers
    finally:
        app.dependency_overrides.pop(get_photo_storage, None)


def test_list_requests_page_upper_bound(client):
    valid = client.get("/api/requests", params={"page": 500})
    invalid = client.get("/api/requests", params={"page": 501})
    assert valid.status_code == 200
    assert invalid.status_code == 422
    assert invalid.json()["error"]["code"] == "VALIDATION_ERROR"
    assert invalid.json()["error"]["fields"]["page"] == "입력값을 확인해 주세요."


def test_list_applicants_sort_matches_counts(client_factory, post_headers, test_ns):
    from tests._application_support import apply, create_request as create_application_request, signup as signup_application_user
    from conftest import ns_email

    buyer = client_factory()
    signup_application_user(buyer, post_headers, test_ns, "sort-buyer")
    request_ids = [
        create_application_request(buyer, post_headers, test_ns, f"sort-{index}")["id"]
        for index in range(3)
    ]
    sellers = [client_factory() for _ in range(2)]
    for index, seller in enumerate(sellers):
        signup_application_user(seller, post_headers, test_ns, f"sort-seller-{index}")
    assert apply(sellers[0], post_headers, request_ids[0]).status_code == 201
    assert apply(sellers[1], post_headers, request_ids[0]).status_code == 201
    assert apply(sellers[0], post_headers, request_ids[1]).status_code == 201

    response = buyer.get("/api/requests", params={"q": test_ns, "sort": "applicants"})
    assert response.status_code == 200, response.text
    rows = response.json()["items"]
    assert [row["applicantCount"] for row in rows] == [2, 1, 0]
    assert [row["id"] for row in rows] == request_ids


def test_list_query_has_no_users_join(client, db_engine, test_ns):
    from app.db.session import SessionLocal
    engine = SessionLocal.kw["bind"]
    statements = []
    def capture(_conn, _cursor, statement, _params, _context, _many):
        if "purchase_requests" in statement.lower():
            statements.append(statement.lower())
    event.listen(engine, "before_cursor_execute", capture)
    try:
        response = client.get("/api/requests", params={"q": test_ns})
    finally:
        event.remove(engine, "before_cursor_execute", capture)
    assert response.status_code == 200
    assert statements
    assert all("app_private.users" not in statement for statement in statements)


def test_list_price_and_inbox_use_indexes(rollback_connection):
    rollback_connection.execute(text("SET LOCAL enable_seqscan = off"))
    price_plan = "\n".join(rollback_connection.scalars(text("""
        EXPLAIN SELECT id FROM app_private.purchase_requests
        ORDER BY price_max DESC, created_at DESC, id DESC LIMIT 12
    """)))
    inbox_plan = "\n".join(rollback_connection.scalars(text("""
        EXPLAIN SELECT id FROM app_private.seller_applications
        WHERE buyer_id = '00000000-0000-4000-8000-000000000001'
           OR seller_id = '00000000-0000-4000-8000-000000000001'
    """)))
    assert "ix_purchase_requests_price_created_id" in price_plan
    assert "ix_seller_applications_buyer_id" in inbox_plan
