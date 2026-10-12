from __future__ import annotations

import ast
import importlib.util
import re
from io import StringIO
from pathlib import Path

import pytest
from sqlalchemy.dialects import postgresql


MIGRATION_PATH = Path(__file__).parents[1] / "migrations" / "versions" / "0007_completion_reviews.py"


def migration_module():
    assert MIGRATION_PATH.is_file(), "0007 migration is required by the approved completion/reviews contract"
    spec = importlib.util.spec_from_file_location("migration_0007_completion_reviews", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_0007_revision_chain_and_upgrade_offline_sql():
    migration = migration_module()
    assert migration.revision == "0007_completion_reviews"
    assert migration.down_revision == "0006_security_perf_hardening"
    assert len(migration.revision) <= 32

    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    output = StringIO()
    context = MigrationContext.configure(
        dialect=postgresql.dialect(), opts={"as_sql": True, "output_buffer": output}
    )
    with Operations.context(context):
        migration.upgrade()
    sql = output.getvalue()
    lock_timeout = re.search(r"SET LOCAL lock_timeout\s*=\s*'5s'", sql, re.IGNORECASE)
    first_alter = re.search(r"\bALTER\s+TABLE\b", sql, re.IGNORECASE)
    assert lock_timeout is not None and first_alter is not None
    assert lock_timeout.start() < first_alter.start(), "finite migration lock_timeout must precede DDL"
    assert "ADD COLUMN IF NOT EXISTS completed_at" in sql
    assert "CREATE TABLE IF NOT EXISTS app_private.reviews" in sql
    assert "ix_reviews_reviewee_id" in sql
    assert "ix_reviews_reviewer_id" in sql
    assert re.search(r"\b(DELETE\s+FROM|TRUNCATE|UPDATE|ALEMBIC_VERSION)\b", sql, re.IGNORECASE) is None
    assert sql.count("DROP CONSTRAINT IF EXISTS ck_purchase_requests_status") == 1
    assert "DROP TABLE" not in sql and "DROP COLUMN" not in sql


def test_0007_downgrade_fails_before_emitting_ddl():
    migration = migration_module()
    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    output = StringIO()
    context = MigrationContext.configure(
        dialect=postgresql.dialect(), opts={"as_sql": True, "output_buffer": output}
    )
    with Operations.context(context), pytest.raises(RuntimeError):
        migration.downgrade()
    assert output.getvalue() == ""

    tree = ast.parse(MIGRATION_PATH.read_text())
    function = next(
        node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "downgrade"
    )
    assert len(function.body) == 1
    assert isinstance(function.body[0], ast.Raise)
