# 11. Transaction completion and reviews — RED evidence

Date: 2026-10-12

## Contract source

Tests were finalized after `docs/specs/11-transaction-completion-reviews.md` showed the approved marker dated 2026-10-12. The approved H4 contract makes reviews public immediately, including to anonymous visitors. Public GET returns at most two role-ordered `items`, whose exact keys are `reviewerRole`, `rating`, `body`, and `createdAt`; public items contain no review id or user identity. `viewerRole`, `mine`, `received`, and `canWrite` are participant-aware, while anonymous and nonparticipant viewers receive null/null/null/false and the same public items. POST remains participant-only; transaction completion remains buyer-only.

## Added acceptance coverage

- `backend/tests/test_transaction_completion.py`: buyer-only completion, request-state/path/Origin handling, stable idempotency and timestamps, completed detail/chat states, readonly sends with message history retained, and request/room list serialization.
- `backend/tests/test_completion_concurrency.py`: deterministic send-vs-completion serialization by observing the sender blocked on the accepted-application row and rejecting the send after the completion state commits.
- `backend/tests/test_reviews.py`: reciprocal participant reviews, immediate anonymous visibility, exact public item shape and order, no user/email/review-id leakage, equivalent anonymous/nonparticipant responses, optional-auth failure behavior, public reads versus restricted writes, incomplete-request rejection, strict payload validation, content-idempotency, and duplicate concurrency.
- `backend/tests/test_migration_0007.py`: offline revision chain/upgrade SQL and unsupported downgrade behavior. `backend/tests/conftest.py` is intentionally unchanged because `0007_completion_reviews` does not exist yet; add it as the explicit preferred target only once the migration file is present.
- Frontend tests cover review/complete API calls and parsing, completion confirmation and error states, participant write panel, public review list and retry behavior, public review display on completed request detail for an anonymous viewer, and completed enum parsing in request/application/chat clients. `ChatMessagePanel.test.tsx` also checks buyer-only completion visibility and refresh after the completed state arrives by polling.

## RED runs

- Backend: `cd backend && uv run pytest -q tests/test_transaction_completion.py tests/test_reviews.py tests/test_completion_concurrency.py tests/test_migration_0007.py` — **30 failed** against the current code (final targeted run after correcting a test email-length issue). Completion and review routes currently return 404/`INTERNAL_ERROR`; the concurrency test reached the database but `purchase_requests.completed_at` is absent; both migration tests fail because `0007_completion_reviews.py` is absent.
- Frontend: `cd frontend && npm test -- --reporter=dot tests/reviewsApi.test.ts tests/CompleteTransactionButton.test.tsx tests/ReviewPanel.test.tsx tests/PublicReviewList.test.tsx tests/RequestDetail.test.tsx tests/ChatMessagePanel.test.tsx tests/requestsApi.test.ts tests/applicationsApi.test.ts tests/chatApi.test.ts` — **9 test files failed, 7 assertions failed, 133 passed**. Four new feature suites cannot resolve their not-yet-implemented modules; the remaining failures show the completed enum parsers, completed request detail, and completion-button/poll behavior are not implemented yet.

The backend test fixture retained its explicit `0006_security_perf_hardening` target because the `0007` file was not available. No database was created or dropped, and no data was deleted; the tests created namespaced local validation records, which remain in the shared DB as required. The concurrency setup that could not execute its completed-state UPDATE rolled back when the missing-column statement failed.
