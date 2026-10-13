# 11. Transaction completion and reviews — backend verification

Date: 2026-10-12

## Implementation

- Added migration `0007_completion_reviews` over `0006_security_perf_hardening`, with completion state/checks and private reciprocal review storage. Downgrade raises before emitting DDL.
- Added buyer-only idempotent completion with request `FOR NO KEY UPDATE` followed by accepted-application `FOR UPDATE`; one `clock_timestamp()` value is written to `completed_at` and `updated_at` after both locks.
- Completed chat state is exposed as `completed`; send checks request status again after acquiring room/application locks, and matching attempts against a completed request return `REQUEST_CLOSED`.
- Added strict immutable review creation and idempotency, role-derived participants, and public review GET with role-only four-field review DTOs and participant-only personalized fields.
- Migration test fixture explicitly advances the shared loopback DB to `0007_completion_reviews`. No test data was deleted; the existing shared validation rows remain.

## Verification

- Targeted acceptance and migration suite: `uv run pytest -q tests/test_transaction_completion.py tests/test_reviews.py tests/test_completion_concurrency.py tests/test_migration_0007.py` — **30 passed**.
- Full backend suite after migration re-execution guard cleanup: `uv run pytest -q` — **272 passed in 65.96s**.
- Both runs emitted only existing Starlette/httpx deprecation warnings.
- The first targeted run had one test setup issue: a namespaced email label exceeded the fixture's 64-character local-part guard. The test label was shortened; no assertion or contract changed.

## Performance review follow-up

- Added `SET LOCAL lock_timeout = '5s'` as the first upgrade operation, before the first `ALTER TABLE`, so an unavailable table lock fails the migration promptly and the transaction rolls back.
- The offline migration test now asserts that this finite timeout is emitted before any `ALTER TABLE` statement.
- Focused migration tests: `uv run pytest -q tests/test_migration_0007.py` — **2 passed**. The 272-test full suite result above remains valid for runtime code, which this migration-only follow-up does not change.

## Database handling

- Used the existing loopback Docker database; applied revision 0007 through the test fixture.
- Did not create a new database, delete validation rows, drop tables or columns, or run stamp or downgrade operations. The migration atomically replaced the status CHECK as specified.
