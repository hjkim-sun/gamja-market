# 07 구매요청 사진 백엔드 검증

검증일: 2026-09-26
범위: FastAPI 사진 업로드·연결·조회, Pillow 정규화, local/Supabase 어댑터, 추가형 마이그레이션과 정리 작업

## 구현 결과

- `POST /api/request-photos`는 raw image body(3 MiB)를 인증·동일 출처 검사 후 Pillow로 완전 디코딩하고, EXIF 방향을 반영하며 메타데이터 없이 같은 포맷으로 재인코딩한다. UUID 의도 행을 먼저 기록하고 Storage 성공 뒤 `pending`으로 확정하며, 실패 시 `discarded` 전환이 커밋된 뒤에만 보상 삭제를 시도한다.
- `POST /api/requests`의 선택 `photoIds`는 최대 5개·중복 불가이고, 소유자/상태/24시간/현재 스토리지 이름공간을 검증해 ID 오름차순 잠금 후 요청 배열 순서를 `sort_order`로 보존한다. 목록은 대표 사진을 한 번에 가져오고 상세는 사진을 한 번에 가져오며, Storage 읽기 호출 없이 URL만 조립한다.
- `0004_request_photos`는 `0002_create_purchase_requests`를 기반으로 `app_private.purchase_request_photos`만 `IF NOT EXISTS`로 추가한다. 테스트 지원 도구로 두 번 호출해도 `alembic_version` 내용이 바뀌지 않는 것을 확인했다.

## 실행한 검증

```text
cd backend
uv run python -m compileall -q app
# exit 0

uv run python -m pytest -q
103 passed, 2 warnings

git diff --check
# exit 0
```

사진 계약 테스트는 JPEG/PNG/WebP 실제 디코드와 EXIF 제거, 팔레트 PNG 투명도 보존, 잘못된 형식·크기·애니메이션 거부, 인증/CSRF, 사용자별 동시 10개 한도, Storage 실패 보상, 소유권, 연결 순서, 추가형 migration, dry-run/apply 정리를 포함한다. 보상 회귀는 pending 확정 커밋의 적용 후 예외·적용 전 예외, 독립 세션 재조회 실패, 폐기/sweep 커밋 실패, 저장소 삭제 실패의 retryable discarded 상태를 검증하며, 어느 경우에도 durable discarded 전 객체 삭제가 일어나지 않음을 확인한다. 추가 어댑터 테스트는 `httpx.MockTransport`로 `sb_secret_` 키에는 `apikey`만, 레거시 JWT에는 추가 Bearer 헤더를 확인하고, 설정의 `SecretStr` 표현 및 안전하지 않은 설정 거부도 확인한다.

## 제한 사항

- 실제 Supabase 자격 증명·버킷이 제공되지 않아 실제 Storage 통합은 수행하지 않았다. Supabase 동작은 MockTransport와 fake storage로만 검증했다.
- 8105/3105 서버 및 브라우저 UI 검증은 UI 작업자와 조율 전이므로 시작하지 않았다. 정리 CLI는 기본 dry-run이며, 공유 DB에서 범위 없는 `--apply`는 실행하지 않았다.
