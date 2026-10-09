"""Migration 0006 assertions; database object checks are read-only/rollback-only."""
from __future__ import annotations

import importlib.util
import re
from io import StringIO
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import IntegrityError


MIGRATION_PATH = Path(__file__).parents[1] / "migrations" / "versions" / "0006_security_perf_hardening.py"


def _migration_module():
    spec = importlib.util.spec_from_file_location("migration_0006_security_perf_hardening", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_0006_revision_chain_and_offline_sql():
    migration = _migration_module()
    assert migration.revision == "0006_security_perf_hardening"
    assert migration.down_revision == "0005_chat_matching"

    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    output = StringIO()
    context = MigrationContext.configure(
        dialect=postgresql.dialect(), opts={"as_sql": True, "output_buffer": output}
    )
    with Operations.context(context):
        migration.upgrade()
    sql = output.getvalue()
    assert sql.count("IF NOT EXISTS") == 4
    assert "CREATE TABLE IF NOT EXISTS app_private.auth_rate_limits" in sql
    assert "CREATE INDEX IF NOT EXISTS ix_auth_rate_limits_updated_at" in sql
    assert "CREATE INDEX IF NOT EXISTS ix_seller_applications_buyer_id" in sql
    assert "CREATE INDEX IF NOT EXISTS ix_purchase_requests_price_created_id" in sql
    assert re.search(r"\b(DELETE|UPDATE|TRUNCATE|DROP)\b|ALEMBIC_VERSION", sql, re.IGNORECASE) is None


def test_0006_objects_exist_after_upgrade(rollback_connection):
    rows = rollback_connection.execute(text("""
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'app_private'
    """)).mappings().all()
    indexes = {row["indexname"]: row["indexdef"] for row in rows}
    required = {
        "ix_auth_rate_limits_updated_at",
        "ix_seller_applications_buyer_id",
        "ix_purchase_requests_price_created_id",
    }
    assert required <= indexes.keys()
    assert rollback_connection.scalar(text("SELECT to_regclass('app_private.auth_rate_limits')")) is not None
    assert "updated_at" in indexes["ix_auth_rate_limits_updated_at"]
    assert "buyer_id" in indexes["ix_seller_applications_buyer_id"]
    assert all(column in indexes["ix_purchase_requests_price_created_id"] for column in ("price_max", "created_at", "id"))


def test_models_and_db_have_no_index_drift(rollback_connection):
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext
    from app.db.models import Base

    changes = compare_metadata(
        MigrationContext.configure(rollback_connection, opts={"include_schemas": True}), Base.metadata
    )
    drift = [
        change for change in changes
        if change[0] in {"add_index", "remove_index"}
        and getattr(getattr(change[1], "table", None), "schema", getattr(change[1], "schema", None)) == "app_private"
    ]
    assert drift == []


def test_auth_rate_limits_check_constraint(rollback_connection):
    from uuid import uuid4

    with pytest.raises(IntegrityError) as error:
        rollback_connection.execute(text("""
            INSERT INTO app_private.auth_rate_limits (bucket_key, window_started_at, hit_count)
            VALUES (:key, now(), 0)
        """), {"key": uuid4().hex + uuid4().hex})
    assert error.value.orig.diag.constraint_name == "ck_auth_rate_limits_hit_count"
