from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Engine, create_engine, inspect


SCHEMA = "app_private"
PREREQUISITE_TABLES = {"users", "auth_sessions", "purchase_requests"}
PHOTO_TABLE = "purchase_request_photos"
EXPECTED_PHOTO_COLUMNS = {
    "id", "uploader_id", "request_id", "status", "storage_backend",
    "storage_bucket", "storage_path", "content_type", "byte_size", "width",
    "height", "sort_order", "created_at", "updated_at", "discarded_at",
    "object_deleted_at",
}
EXPECTED_PHOTO_CHECKS = {
    "ck_request_photos_status", "ck_request_photos_backend",
    "ck_request_photos_bucket", "ck_request_photos_content_type",
    "ck_request_photos_byte_size", "ck_request_photos_pixels",
    "ck_request_photos_sort_order", "ck_request_photos_attached_link",
    "ck_request_photos_discarded_at", "ck_request_photos_deleted_only_discarded",
}
EXPECTED_PHOTO_INDEXES = {
    "uq_request_photos_storage_path", "uq_request_photos_request_sort",
    "ix_request_photos_request_id", "ix_request_photos_uploader_status",
    "ix_request_photos_cleanup",
}


def _migration_path() -> Path:
    return Path(__file__).parents[2] / "migrations" / "versions" / "0004_create_purchase_request_photos.py"


def _load_migration(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location("tests_stage5_request_photos", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"사진 마이그레이션을 불러올 수 없습니다: {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _verify_photo_schema(engine: Engine) -> None:
    db = inspect(engine)
    if not db.has_table(PHOTO_TABLE, schema=SCHEMA):
        raise RuntimeError("0004_request_photos 적용 후 사진 테이블이 없습니다.")
    columns = {column["name"] for column in db.get_columns(PHOTO_TABLE, schema=SCHEMA)}
    checks = {c["name"] for c in db.get_check_constraints(PHOTO_TABLE, schema=SCHEMA)}
    indexes = {index["name"] for index in db.get_indexes(PHOTO_TABLE, schema=SCHEMA)}
    missing = {
        "columns": EXPECTED_PHOTO_COLUMNS - columns,
        "checks": EXPECTED_PHOTO_CHECKS - checks,
        "indexes": EXPECTED_PHOTO_INDEXES - indexes,
    }
    if any(missing.values()):
        raise RuntimeError(f"기존 사진 스키마가 승인 명세와 다릅니다: {missing}")


def ensure_additive_schema(engine: Engine) -> None:
    """Apply only 0004's idempotent additive DDL, never Alembic version state."""
    db = inspect(engine)
    missing_prerequisites = {
        table for table in PREREQUISITE_TABLES if not db.has_table(table, schema=SCHEMA)
    }
    if missing_prerequisites:
        missing = ", ".join(sorted(missing_prerequisites))
        raise RuntimeError(
            f"필수 로컬 스키마가 없습니다({missing}). 운영 절차로 0001/0002를 먼저 적용하세요."
        )

    migration_path = _migration_path()
    if not migration_path.exists():
        # Expected during RED: current regressions run before production creates 0004.
        return

    migration = _load_migration(migration_path)
    if getattr(migration, "revision", None) != "0004_request_photos":
        raise RuntimeError("사진 마이그레이션 revision은 0004_request_photos여야 합니다.")

    with engine.begin() as connection:
        operations = Operations(MigrationContext.configure(connection))
        original_op = getattr(migration, "op", None)
        migration.op = operations
        try:
            migration.upgrade()
        finally:
            migration.op = original_op

    _verify_photo_schema(engine)


def main() -> None:
    from app.core.config import get_settings

    engine = create_engine(get_settings().database_url)
    try:
        ensure_additive_schema(engine)
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
